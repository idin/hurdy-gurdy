import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";

import { buildCacheKey, CACHE_TIME_TO_LIVE_MILLISECONDS } from "../../src/cache/cache_entry";
import {
  findAlbumCoverage,
  findArtistCoverage,
  findCachedResponse,
  findPlaylistMembership,
  prepareMediaCache,
  renewCachedResponse,
  storeCachedResponse,
  sweepExpiredResponses,
} from "../../src/cache/media_cache_store";

/**
 * Run against a real D1, not a stand-in.
 *
 * The risk in this file is whether the SQL is correct — particularly the
 * coverage views, whose whole purpose is to compute counts nobody stores. A
 * fake database that records statements without executing them would pass
 * while every view was wrong, which is the shape of failure these tests exist
 * to catch.
 */

const database = (env as { MEDIA_CACHE: D1Database }).MEDIA_CACHE;
const NOW = Date.parse("2026-09-13T12:00:00Z");

/** Insert an album with `total` tracks, of which the first `liked` are liked. */
async function seedAlbum(options: {
  albumUri: string;
  artistUri: string;
  total: number;
  liked: number;
  totalTracks: number | null;
}): Promise<void> {
  await database
    .prepare(`INSERT INTO album VALUES (?, 'a', 'An Album', '1971-10-31', ?, 0, ?)`)
    .bind(options.albumUri, options.totalTracks, NOW)
    .run();
  await database
    .prepare(`INSERT OR IGNORE INTO artist VALUES (?, 'ar', 'An Artist', '[]', 1, NULL, NULL, ?)`)
    .bind(options.artistUri, NOW)
    .run();
  for (let index = 1; index <= options.total; index += 1) {
    const trackUri = `${options.albumUri}:t${index}`;
    await database
      .prepare(`INSERT INTO track VALUES (?, 't', 'A Track', ?, 200000, ?, NULL, ?)`)
      .bind(trackUri, options.albumUri, index <= options.liked ? 1 : 0, NOW)
      .run();
    await database
      .prepare(`INSERT INTO track_artist VALUES (?, ?)`)
      .bind(trackUri, options.artistUri)
      .run();
  }
}

beforeEach(async () => {
  await prepareMediaCache(database);
  // Each test starts from an empty store: these run in one isolate against
  // one database, so leftover rows from a previous test would make coverage
  // counts depend on test order.
  for (const table of [
    "cached_response",
    "track_artist",
    "album_artist",
    "playlist_track",
    "track",
    "album",
    "artist",
    "playlist",
  ]) {
    await database.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("cached responses", () => {
  test("a stored entry comes back fresh", async () => {
    const key = buildCacheKey("spotify", "getLikedTracks", { cursor: "0" });
    await storeCachedResponse(
      database,
      { key, payload: '{"items":[]}', etag: 'W/"abc"', total: 40 },
      NOW,
    );

    const lookup = await findCachedResponse(database, key, NOW);

    expect(lookup.state).toBe("fresh");
  });

  test("reading a fresh entry pushes its expiry back in the database", async () => {
    // The failure this catches: an entry in daily use expiring anyway,
    // because the renewal was computed but never written.
    const key = buildCacheKey("spotify", "getLikedTracks", {});
    await storeCachedResponse(database, { key, payload: "{}", etag: null, total: null }, NOW);

    const laterRead = NOW + 60_000;
    await findCachedResponse(database, key, laterRead);

    const row = await database
      .prepare(`SELECT expires_at AS expiresAt FROM cached_response WHERE key = ?`)
      .bind(key)
      .first<{ expiresAt: number }>();
    expect(row?.expiresAt).toBe(laterRead + CACHE_TIME_TO_LIVE_MILLISECONDS);
  });

  test("an expired entry reads as stale, keeping its etag for revalidation", async () => {
    const key = buildCacheKey("spotify", "getPlaylists", {});
    await storeCachedResponse(
      database,
      { key, payload: "{}", etag: 'W/"tag"', total: 131 },
      NOW,
    );

    const lookup = await findCachedResponse(
      database,
      key,
      NOW + CACHE_TIME_TO_LIVE_MILLISECONDS + 1,
    );

    expect(lookup.state).toBe("stale");
    // Stale must keep the etag: that is what makes revalidation free.
    if (lookup.state === "stale") {
      expect(lookup.entry.etag).toBe('W/"tag"');
    }
  });

  test("a missing key reads as missing, not as an error", async () => {
    const lookup = await findCachedResponse(database, "nothing:here", NOW);
    expect(lookup.state).toBe("missing");
  });

  test("storing the same key twice replaces rather than duplicates", async () => {
    const key = buildCacheKey("spotify", "search", { query: "queen" });
    await storeCachedResponse(database, { key, payload: "first", etag: null, total: null }, NOW);
    await storeCachedResponse(database, { key, payload: "second", etag: null, total: null }, NOW);

    const lookup = await findCachedResponse(database, key, NOW);
    if (lookup.state !== "fresh") {
      throw new Error(`expected fresh, got ${lookup.state}`);
    }
    expect(lookup.entry.payload).toBe("second");
  });

  test("renewing extends a stale entry without touching its payload", async () => {
    const key = buildCacheKey("spotify", "getPlaylists", {});
    await storeCachedResponse(database, { key, payload: "body", etag: 'W/"t"', total: 1 }, NOW);

    const muchLater = NOW + CACHE_TIME_TO_LIVE_MILLISECONDS + 1;
    await renewCachedResponse(database, key, muchLater);

    const lookup = await findCachedResponse(database, key, muchLater);
    expect(lookup.state).toBe("fresh");
    if (lookup.state === "fresh") {
      expect(lookup.entry.payload).toBe("body");
    }
  });

  test("the sweep deletes expired rows and leaves live ones", async () => {
    // This is what makes "do not store indefinitely" literally true rather
    // than merely claimed.
    await storeCachedResponse(
      database,
      { key: "old", payload: "{}", etag: null, total: null },
      NOW,
    );
    await storeCachedResponse(
      database,
      { key: "new", payload: "{}", etag: null, total: null },
      NOW + CACHE_TIME_TO_LIVE_MILLISECONDS,
    );

    const removed = await sweepExpiredResponses(
      database,
      NOW + CACHE_TIME_TO_LIVE_MILLISECONDS + 1,
    );

    expect(removed).toBe(1);
    expect((await findCachedResponse(database, "new", NOW)).state).not.toBe("missing");
  });
});

describe("album coverage", () => {
  test("counts liked tracks against the album's own total", async () => {
    await seedAlbum({
      albumUri: "spotify:album:meddle",
      artistUri: "spotify:artist:pf",
      total: 12,
      liked: 3,
      totalTracks: 12,
    });

    const coverage = await findAlbumCoverage(database, ["spotify:album:meddle"]);

    expect(coverage.get("spotify:album:meddle")).toEqual({
      likedTrackCount: 3,
      totalTrackCount: 12,
      hasAnyLiked: true,
    });
  });

  test("moves when a track is liked, with nothing else written", async () => {
    // The point of deriving rather than storing: no invalidation step exists
    // to forget, because there is no stored count to invalidate.
    await seedAlbum({
      albumUri: "spotify:album:meddle",
      artistUri: "spotify:artist:pf",
      total: 12,
      liked: 3,
      totalTracks: 12,
    });

    await database
      .prepare(`UPDATE track SET is_liked = 1 WHERE uri = 'spotify:album:meddle:t4'`)
      .run();

    const coverage = await findAlbumCoverage(database, ["spotify:album:meddle"]);
    expect(coverage.get("spotify:album:meddle")?.likedTrackCount).toBe(4);
  });

  test("an album with no liked tracks reports zero, not absence", async () => {
    await seedAlbum({
      albumUri: "spotify:album:none",
      artistUri: "spotify:artist:x",
      total: 5,
      liked: 0,
      totalTracks: 5,
    });

    const coverage = await findAlbumCoverage(database, ["spotify:album:none"]);

    expect(coverage.get("spotify:album:none")).toEqual({
      likedTrackCount: 0,
      totalTrackCount: 5,
      hasAnyLiked: false,
    });
  });

  test("keeps the total null when the provider withheld it", async () => {
    // Null and zero are different claims: a total nobody reported is not a
    // total of nothing.
    await seedAlbum({
      albumUri: "spotify:album:unknown",
      artistUri: "spotify:artist:x",
      total: 3,
      liked: 1,
      totalTracks: null,
    });

    const coverage = await findAlbumCoverage(database, ["spotify:album:unknown"]);
    expect(coverage.get("spotify:album:unknown")?.totalTrackCount).toBeNull();
  });

  test("an album the cache has never seen is simply absent", async () => {
    const coverage = await findAlbumCoverage(database, ["spotify:album:never"]);
    expect(coverage.has("spotify:album:never")).toBe(false);
  });
});

describe("artist coverage", () => {
  test("counts liked tracks and the albums they span", async () => {
    // Two albums by one artist, liked tracks on both: the album axis is what
    // distinguishes forty tracks from one album from one track from forty.
    await seedAlbum({
      albumUri: "spotify:album:one",
      artistUri: "spotify:artist:pf",
      total: 5,
      liked: 2,
      totalTracks: 5,
    });
    await seedAlbum({
      albumUri: "spotify:album:two",
      artistUri: "spotify:artist:pf",
      total: 5,
      liked: 1,
      totalTracks: 5,
    });

    const coverage = await findArtistCoverage(database, ["spotify:artist:pf"]);

    expect(coverage.get("spotify:artist:pf")).toEqual({
      likedTrackCount: 3,
      totalTrackCount: null,
      albumsWithLikedTracks: 2,
      totalAlbumCount: null,
      hasAnyLiked: true,
    });
  });

  test("counts only albums that actually have a liked track", async () => {
    await seedAlbum({
      albumUri: "spotify:album:liked",
      artistUri: "spotify:artist:pf",
      total: 4,
      liked: 1,
      totalTracks: 4,
    });
    await seedAlbum({
      albumUri: "spotify:album:unliked",
      artistUri: "spotify:artist:pf",
      total: 4,
      liked: 0,
      totalTracks: 4,
    });

    const coverage = await findArtistCoverage(database, ["spotify:artist:pf"]);
    expect(coverage.get("spotify:artist:pf")?.albumsWithLikedTracks).toBe(1);
  });

  test("a followed artist with nothing liked reports zero and false", async () => {
    // The distinction Idin drew: following an artist and having liked
    // anything by them are different facts.
    await database
      .prepare(`INSERT INTO artist VALUES ('spotify:artist:new', 'n', 'New', '[]', 1, NULL, NULL, ?)`)
      .bind(NOW)
      .run();

    const coverage = await findArtistCoverage(database, ["spotify:artist:new"]);

    expect(coverage.get("spotify:artist:new")?.likedTrackCount).toBe(0);
    expect(coverage.get("spotify:artist:new")?.hasAnyLiked).toBe(false);
  });

  test("reports the resolver's totals once it has filled them in", async () => {
    await seedAlbum({
      albumUri: "spotify:album:one",
      artistUri: "spotify:artist:pf",
      total: 5,
      liked: 2,
      totalTracks: 5,
    });
    await database
      .prepare(
        `UPDATE artist SET total_track_count = 120, total_album_count = 10
           WHERE uri = 'spotify:artist:pf'`,
      )
      .run();

    const coverage = await findArtistCoverage(database, ["spotify:artist:pf"]);

    expect(coverage.get("spotify:artist:pf")?.totalTrackCount).toBe(120);
    expect(coverage.get("spotify:artist:pf")?.totalAlbumCount).toBe(10);
  });
});

describe("playlist membership", () => {
  test("reports every playlist holding a track", async () => {
    // The state Spotify has no endpoint for: in playlists, never liked.
    await database
      .prepare(`INSERT INTO track VALUES ('spotify:track:t1','t','T',NULL,1,0,NULL,?)`)
      .bind(NOW)
      .run();
    for (const playlist of ["spotify:playlist:p1", "spotify:playlist:p2"]) {
      await database
        .prepare(`INSERT INTO playlist VALUES (?, 'p', 'A List', 'idin.k', 1, 1, ?)`)
        .bind(playlist, NOW)
        .run();
      await database
        .prepare(`INSERT INTO playlist_track VALUES (?, 'spotify:track:t1', 0)`)
        .bind(playlist)
        .run();
    }

    const membership = await findPlaylistMembership(database, ["spotify:track:t1"]);

    expect(membership.get("spotify:track:t1")?.sort()).toEqual([
      "spotify:playlist:p1",
      "spotify:playlist:p2",
    ]);
  });

  test("a track in no playlist is absent rather than an empty list", async () => {
    const membership = await findPlaylistMembership(database, ["spotify:track:lonely"]);
    expect(membership.has("spotify:track:lonely")).toBe(false);
  });
});
