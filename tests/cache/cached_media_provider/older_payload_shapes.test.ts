import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildCacheKey } from "../../../src/cache/cache_entry";
import { CachedMediaProvider } from "../../../src/cache/cached_media_provider";
import { prepareMediaCache, storeCachedResponse } from "../../../src/cache/media_cache_store";
import type { MediaProvider, Page, Track } from "../../../src/providers/media_provider";

/**
 * A cached page written by older code must not break a read by newer code.
 *
 * The response cache stores provider pages as JSON under a 66-day *sliding*
 * expiry, so a page that keeps being read never expires — it outlives any
 * change to the `Track` type. Two such changes have happened:
 *
 * - 2026-09-13 (28d653e) added `isrc` and `albumTrackCount`.
 * - 2026-09-18 (e19a223) replaced `durationMs` with `durationSeconds`.
 *
 * A page cached before either parses with those fields missing, and a missing
 * field is `undefined` — which D1 refuses to bind. Observed 2026-09-30:
 * `get_library` for liked tracks failed with
 * `D1_TYPE_ERROR: Type 'undefined' not supported`, with and without a page
 * size, while playlists read fine.
 *
 * The payloads below are the exact shapes those versions stored.
 */

const database = (env as { MEDIA_CACHE: D1Database }).MEDIA_CACHE;
const NOW = Date.parse("2026-09-30T12:00:00Z");

/** A liked-tracks page as stored before 2026-09-13: no ISRC, milliseconds. */
const PAGE_BEFORE_ISRC = {
  items: [
    {
      uri: "spotify:track:0vFOzaXqZHahrZp6enQwQb",
      inLibrary: true,
      id: "0vFOzaXqZHahrZp6enQwQb",
      name: "Money",
      artists: [{ uri: "spotify:artist:0k17h0D3J5VfsdmQ1iZtE9", name: "Pink Floyd" }],
      artistNames: ["Pink Floyd"],
      albumName: "The Dark Side of the Moon",
      albumUri: "spotify:album:4LH4d3cOWNNsVw41Gqt2kv",
      durationMs: 382826,
    },
  ],
  nextCursor: null,
  total: 1,
};

/** The same page as stored between 2026-09-13 and 2026-09-18: ISRC, still milliseconds. */
const PAGE_BEFORE_SECONDS = {
  ...PAGE_BEFORE_ISRC,
  items: PAGE_BEFORE_ISRC.items.map((item) => ({
    ...item,
    albumTrackCount: 10,
    isrc: "GBN9Y1100088",
  })),
};

/** What the provider returns today, for the same track. */
const CURRENT_PAGE: Page<Track> = {
  items: [
    {
      uri: "spotify:track:0vFOzaXqZHahrZp6enQwQb",
      inLibrary: true,
      id: "0vFOzaXqZHahrZp6enQwQb",
      name: "Money",
      artists: [{ uri: "spotify:artist:0k17h0D3J5VfsdmQ1iZtE9", name: "Pink Floyd" }],
      artistNames: ["Pink Floyd"],
      albumName: "The Dark Side of the Moon",
      albumUri: "spotify:album:4LH4d3cOWNNsVw41Gqt2kv",
      albumTrackCount: 10,
      durationSeconds: 382.826,
      isrc: "GBN9Y1100088",
    },
  ],
  nextCursor: null,
  total: 1,
};

/** How many times the provider was actually asked, per method. */
let providerCalls: Record<string, number> = {};

/** Only the two track reads are reachable from these tests. */
function buildCurrentProvider(): MediaProvider {
  return {
    name: "spotify",
    async getLikedTracks() {
      providerCalls.getLikedTracks = (providerCalls.getLikedTracks ?? 0) + 1;
      return CURRENT_PAGE;
    },
    async getPlaylistTracks() {
      return CURRENT_PAGE;
    },
  } as unknown as MediaProvider;
}

async function cacheLikedTracksPage(
  parameters: Record<string, string | number | undefined>,
  payload: unknown,
): Promise<void> {
  await cachePage("getLikedTracks", parameters, payload);
}

async function cachePage(
  method: string,
  parameters: Record<string, string | number | undefined>,
  payload: unknown,
): Promise<void> {
  await storeCachedResponse(
    database,
    {
      key: buildCacheKey("spotify", method, parameters),
      payload: JSON.stringify(payload),
      etag: null,
      total: 1,
    },
    NOW,
  );
}

beforeEach(async () => {
  providerCalls = {};
  await prepareMediaCache(database);
  for (const table of ["cached_response", "resolution_queue", "track_artist", "track", "album", "artist"]) {
    await database.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("liked tracks cached by older code", () => {
  test("a page from before durationSeconds reads without a D1 type error", async () => {
    await cacheLikedTracksPage({}, PAGE_BEFORE_SECONDS);
    const cached = new CachedMediaProvider(buildCurrentProvider(), database, () => NOW);

    const page = await cached.getLikedTracks();

    expect(page.items[0].durationSeconds).toBe(382.826);
  });

  test("a page from before ISRC reads without a D1 type error", async () => {
    await cacheLikedTracksPage({}, PAGE_BEFORE_ISRC);
    const cached = new CachedMediaProvider(buildCurrentProvider(), database, () => NOW);

    const page = await cached.getLikedTracks();

    expect(page.items[0].isrc).toBe("GBN9Y1100088");
  });

  test("the same holds when a page size was asked for", async () => {
    await cacheLikedTracksPage({ limit: 50 }, PAGE_BEFORE_SECONDS);
    const cached = new CachedMediaProvider(buildCurrentProvider(), database, () => NOW);

    const page = await cached.getLikedTracks({ limit: 50 });

    expect(page.items[0].durationSeconds).toBe(382.826);
  });

  test("the library ends up holding the track, with its real duration", async () => {
    await cacheLikedTracksPage({}, PAGE_BEFORE_SECONDS);
    const cached = new CachedMediaProvider(buildCurrentProvider(), database, () => NOW);

    await cached.getLikedTracks();

    const row = await database
      .prepare(`SELECT duration_seconds, is_liked FROM track WHERE uri = ?`)
      .bind("spotify:track:0vFOzaXqZHahrZp6enQwQb")
      .first<{ duration_seconds: number; is_liked: number }>();
    expect(row).toEqual({ duration_seconds: 382.826, is_liked: 1 });
  });

  test("playlist tracks cached by older code read too, since they share the shape", async () => {
    const playlistId = "37i9dQZF1DX4UtSsGT1Sbe";
    await cachePage("getPlaylistTracks", { playlistId }, PAGE_BEFORE_SECONDS);
    const cached = new CachedMediaProvider(buildCurrentProvider(), database, () => NOW);

    const page = await cached.getPlaylistTracks(playlistId);

    expect(page.items[0].durationSeconds).toBe(382.826);
  });

  test("an old entry costs one refetch, then the replacement is served from cache", async () => {
    await cacheLikedTracksPage({}, PAGE_BEFORE_SECONDS);
    const cached = new CachedMediaProvider(buildCurrentProvider(), database, () => NOW);

    await cached.getLikedTracks();
    await cached.getLikedTracks();
    await cached.getLikedTracks();

    expect(providerCalls.getLikedTracks).toBe(1);
  });

  test("a rejected entry is logged with the field that failed", async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message: string) => {
      warnings.push(message);
    });
    await cacheLikedTracksPage({}, PAGE_BEFORE_SECONDS);
    const cached = new CachedMediaProvider(buildCurrentProvider(), database, () => NOW);

    await cached.getLikedTracks();

    expect(warnings.map((warning) => JSON.parse(warning))).toEqual([
      {
        kind: "cached_payload_rejected",
        key: "spotify:getLikedTracks",
        path: "items.0.durationSeconds",
        message: expect.any(String),
      },
    ]);
    spy.mockRestore();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
