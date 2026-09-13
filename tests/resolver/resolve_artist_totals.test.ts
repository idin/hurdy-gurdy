import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { prepareMediaCache } from "../../src/cache/media_cache_store";
import { SpotifyApiClient } from "../../src/providers/spotify/spotify_api_client";
import {
  countPendingResolutions,
  enqueueResolutions,
  findNextResolution,
  MAXIMUM_ATTEMPTS,
  RESOLUTION_PRIORITY,
} from "../../src/resolver/resolution_queue";
import { runResolutionTask } from "../../src/resolver/resolve_artist_totals";

/**
 * The two risks here are resuming and partial sums.
 *
 * A 312-release artist takes many ticks, so a crawl that restarts each time
 * never finishes and one that loses its running total counts wrong. And a
 * partial sum written to the artist row is a *wrong denominator*, which is
 * worse than an absent one: "3 of 40" when the truth is "3 of 312" reads as a
 * strong relationship where there is a weak one.
 */

const database = (env as { MEDIA_CACHE: D1Database }).MEDIA_CACHE;
const NOW = Date.parse("2026-09-13T12:00:00Z");
const ARTIST = "spotify:artist:pf";

/** A paging response shaped like Spotify's, with `next` set when more remain. */
function albumsPage(options: { offset: number; total: number; trackCounts: number[] }) {
  const consumed = options.offset + options.trackCounts.length;
  return JSON.stringify({
    href: "https://api.spotify.com/v1/artists/pf/albums",
    limit: 10,
    next: consumed < options.total ? "https://api.spotify.com/v1/next" : null,
    offset: options.offset,
    previous: null,
    total: options.total,
    items: options.trackCounts.map((total_tracks, index) => ({
      id: `album-${options.offset + index}`,
      name: `Album ${options.offset + index}`,
      artists: [{ id: "pf", name: "Pink Floyd" }],
      release_date: "1971",
      total_tracks,
      uri: `spotify:album:album-${options.offset + index}`,
      images: [],
    })),
  });
}

/** Serves pages of ten, counting how many requests were made. */
function pagedFetch(totalAlbums: number, tracksPerAlbum: number) {
  const requests: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    requests.push(url.toString());
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const remaining = Math.max(0, totalAlbums - offset);
    const size = Math.min(10, remaining);
    return new Response(
      albumsPage({
        offset,
        total: totalAlbums,
        trackCounts: Array.from({ length: size }, () => tracksPerAlbum),
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return requests;
}

async function seedArtist(): Promise<void> {
  await database
    .prepare(`INSERT INTO artist VALUES (?, 'pf', 'Pink Floyd', '[]', 1, NULL, NULL, ?)`)
    .bind(ARTIST, NOW)
    .run();
}

async function readTotals(): Promise<{ tracks: number | null; albums: number | null }> {
  const row = await database
    .prepare(`SELECT total_track_count, total_album_count FROM artist WHERE uri = ?`)
    .bind(ARTIST)
    .first<{ total_track_count: number | null; total_album_count: number | null }>();
  return { tracks: row?.total_track_count ?? null, albums: row?.total_album_count ?? null };
}

beforeEach(async () => {
  await prepareMediaCache(database);
  for (const table of ["resolution_queue", "artist", "track", "album"]) {
    await database.prepare(`DELETE FROM ${table}`).run();
  }
  await seedArtist();
});

describe("artist album count", () => {
  test("lands from a single request, because total arrives on page one", async () => {
    const requests = pagedFetch(312, 12);
    await enqueueResolutions(
      database,
      [{ kind: "artist-album-count", subjectUri: ARTIST, priority: RESOLUTION_PRIORITY.FOLLOWED_ARTIST }],
      NOW,
    );
    const task = await findNextResolution(database);

    const result = await runResolutionTask(database, new SpotifyApiClient("t"), task!);

    expect(result.outcome).toBe("completed");
    expect((await readTotals()).albums).toBe(312);
    expect(requests).toHaveLength(1);
  });

  test("asks for ten per page, the cap this endpoint actually accepts", async () => {
    // limit=20 and limit=50 both return 400 Invalid limit on the live API.
    const requests = pagedFetch(312, 12);
    await enqueueResolutions(
      database,
      [{ kind: "artist-album-count", subjectUri: ARTIST, priority: RESOLUTION_PRIORITY.FOLLOWED_ARTIST }],
      NOW,
    );
    await runResolutionTask(database, new SpotifyApiClient("t"), (await findNextResolution(database))!);

    expect(requests[0]).toContain("limit=10");
  });

  test("counts albums and singles, not records the artist merely appears on", async () => {
    const requests = pagedFetch(10, 12);
    await enqueueResolutions(
      database,
      [{ kind: "artist-album-count", subjectUri: ARTIST, priority: RESOLUTION_PRIORITY.FOLLOWED_ARTIST }],
      NOW,
    );
    await runResolutionTask(database, new SpotifyApiClient("t"), (await findNextResolution(database))!);

    expect(requests[0]).toContain("include_groups=album%2Csingle");
  });
});

describe("artist track count", () => {
  test("completes in one tick when the artist is small", async () => {
    pagedFetch(5, 10);
    await enqueueResolutions(
      database,
      [{ kind: "artist-track-count", subjectUri: ARTIST, priority: RESOLUTION_PRIORITY.FOLLOWED_ARTIST }],
      NOW,
    );

    const result = await runResolutionTask(
      database,
      new SpotifyApiClient("t"),
      (await findNextResolution(database))!,
    );

    expect(result.outcome).toBe("completed");
    expect((await readTotals()).tracks).toBe(50);
  });

  test("writes nothing to the artist row until the crawl finishes", async () => {
    // A partial sum is a wrong denominator, and a wrong one is worse than an
    // absent one: "3 of 40" reads as a strong relationship where the truth
    // is "3 of 312".
    pagedFetch(100, 10);
    await enqueueResolutions(
      database,
      [{ kind: "artist-track-count", subjectUri: ARTIST, priority: RESOLUTION_PRIORITY.FOLLOWED_ARTIST }],
      NOW,
    );

    const result = await runResolutionTask(
      database,
      new SpotifyApiClient("t"),
      (await findNextResolution(database))!,
    );

    expect(result.outcome).toBe("advanced");
    expect((await readTotals()).tracks).toBeNull();
  });

  test("resumes where it stopped instead of starting over", async () => {
    // The failure this catches: a long crawl that restarts each tick never
    // finishes, and the artist's denominator stays null forever.
    pagedFetch(100, 10);
    await enqueueResolutions(
      database,
      [{ kind: "artist-track-count", subjectUri: ARTIST, priority: RESOLUTION_PRIORITY.FOLLOWED_ARTIST }],
      NOW,
    );

    await runResolutionTask(database, new SpotifyApiClient("t"), (await findNextResolution(database))!);
    const afterFirst = await findNextResolution(database);

    expect(afterFirst?.cursor).toBe("30");
    expect(afterFirst?.accumulated).toBe(300);
  });

  test("reaches the right total across many ticks", async () => {
    // 100 albums of 10 tracks, three pages a tick: four ticks, 1000 tracks.
    pagedFetch(100, 10);
    await enqueueResolutions(
      database,
      [{ kind: "artist-track-count", subjectUri: ARTIST, priority: RESOLUTION_PRIORITY.FOLLOWED_ARTIST }],
      NOW,
    );

    for (let tick = 0; tick < 10; tick += 1) {
      const task = await findNextResolution(database);
      if (task === null) {
        break;
      }
      await runResolutionTask(database, new SpotifyApiClient("t"), task);
    }

    expect((await readTotals()).tracks).toBe(1000);
    expect(await findNextResolution(database)).toBeNull();
  });

  test("an album with no track count contributes zero, not NaN", async () => {
    // The near-miss: total_tracks is optional on a simplified album, and
    // adding undefined would poison the whole sum.
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          href: "h",
          limit: 10,
          next: null,
          offset: 0,
          previous: null,
          total: 1,
          items: [
            { id: "a", name: "A", artists: [], release_date: "1971", uri: "spotify:album:a", images: [] },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    await enqueueResolutions(
      database,
      [{ kind: "artist-track-count", subjectUri: ARTIST, priority: RESOLUTION_PRIORITY.FOLLOWED_ARTIST }],
      NOW,
    );

    await runResolutionTask(database, new SpotifyApiClient("t"), (await findNextResolution(database))!);

    expect((await readTotals()).tracks).toBe(0);
  });
});

describe("failure handling", () => {
  test("a failing task is retried, then stops being selected", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { status: 404 } }), { status: 404 }),
    ) as unknown as typeof fetch;
    await enqueueResolutions(
      database,
      [{ kind: "artist-album-count", subjectUri: ARTIST, priority: RESOLUTION_PRIORITY.FOLLOWED_ARTIST }],
      NOW,
    );

    for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
      const task = await findNextResolution(database);
      expect(task).not.toBeNull();
      const result = await runResolutionTask(database, new SpotifyApiClient("t"), task!);
      expect(result.outcome).toBe("failed");
    }

    // Stuck, not deleted: a visible row is diagnosable, a vanished one is not.
    expect(await findNextResolution(database)).toBeNull();
    expect(await countPendingResolutions(database)).toEqual({ pending: 0, stuck: 1 });
  });

  test("a stuck task does not block the tier behind it", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { status: 404 } }), { status: 404 }),
    ) as unknown as typeof fetch;
    await enqueueResolutions(
      database,
      [
        { kind: "artist-album-count", subjectUri: ARTIST, priority: RESOLUTION_PRIORITY.FOLLOWED_ARTIST },
        { kind: "artist-album-count", subjectUri: "spotify:artist:other", priority: RESOLUTION_PRIORITY.FOLLOWED_ARTIST },
      ],
      NOW,
    );

    for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
      await runResolutionTask(database, new SpotifyApiClient("t"), (await findNextResolution(database))!);
    }

    const next = await findNextResolution(database);
    expect(next?.subjectUri).toBe("spotify:artist:other");
  });
});
