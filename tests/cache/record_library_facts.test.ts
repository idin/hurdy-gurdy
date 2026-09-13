import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";

import { CachedMediaProvider } from "../../src/cache/cached_media_provider";
import { prepareMediaCache } from "../../src/cache/media_cache_store";
import {
  forgetLikedTracks,
  linkTrackRelations,
  recordArtists,
  recordTracks,
} from "../../src/cache/record_library_facts";
import { RESOLUTION_PRIORITY } from "../../src/resolver/resolution_queue";
import type { Artist, MediaProvider, Page, Track } from "../../src/providers/media_provider";

/**
 * The end-to-end question: does reading a library produce working coverage?
 *
 * Everything below the surface has been tested in isolation — the views
 * compute, the store reads them, the decorator calls it. What has never been
 * shown is that a plain `getLikedTracks()` leaves the database in a state
 * where "how many liked tracks does this artist have" has a real answer. That
 * is the only thing a user notices.
 */

const database = (env as { MEDIA_CACHE: D1Database }).MEDIA_CACHE;
const NOW = Date.parse("2026-09-13T12:00:00Z");

function track(
  uri: string,
  name: string,
  artists: { uri: string; name: string }[],
): Track {
  return {
    uri,
    inLibrary: true,
    id: uri.split(":").pop()!,
    name,
    artists,
    artistNames: artists.map((entry) => entry.name),
    albumName: "Meddle",
    albumUri: "spotify:album:meddle",
    durationMs: 1,
  };
}

function artist(uri: string, name: string): Artist {
  return {
    uri,
    inLibrary: true,
    id: uri.split(":").pop()!,
    name,
    genres: [],
    likedTrackCount: 0,
    totalTrackCount: null,
    hasAnyLiked: false,
    albumsWithLikedTracks: 0,
    totalAlbumCount: null,
  };
}

beforeEach(async () => {
  await prepareMediaCache(database);
  for (const table of [
    "cached_response",
    "resolution_queue",
    "track_artist",
    "playlist_track",
    "track",
    "album",
    "artist",
    "playlist",
  ]) {
    await database.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("recordTracks", () => {
  test("a liked track is recorded as liked", async () => {
    await recordTracks(database, [track("spotify:track:t1", "Echoes", [{ uri: "spotify:artist:pf", name: "Pink Floyd" }])], {
      isLiked: true,
      now: NOW,
    });

    const row = await database
      .prepare(`SELECT is_liked FROM track WHERE uri = 'spotify:track:t1'`)
      .first<{ is_liked: number }>();
    expect(row?.is_liked).toBe(1);
  });

  test("meeting a liked track again in a playlist does not un-like it", async () => {
    // The trap: a playlist read knows nothing about likedness, and writing
    // its zero over an existing one would silently empty the library.
    await recordTracks(database, [track("spotify:track:t1", "Echoes", [])], {
      isLiked: true,
      now: NOW,
    });
    await recordTracks(database, [track("spotify:track:t1", "Echoes", [])], {
      isLiked: false,
      now: NOW,
    });

    const row = await database
      .prepare(`SELECT is_liked FROM track WHERE uri = 'spotify:track:t1'`)
      .first<{ is_liked: number }>();
    expect(row?.is_liked).toBe(1);
  });

  test("recording the same track twice does not duplicate it", async () => {
    const one = [track("spotify:track:t1", "Echoes", [])];
    await recordTracks(database, one, { isLiked: true, now: NOW });
    await recordTracks(database, one, { isLiked: true, now: NOW });

    const row = await database
      .prepare(`SELECT COUNT(*) AS count FROM track`)
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });
});

describe("forgetLikedTracks", () => {
  test("unliking clears the flag the views count", async () => {
    await recordTracks(database, [track("spotify:track:t1", "Echoes", [])], {
      isLiked: true,
      now: NOW,
    });

    await forgetLikedTracks(database, ["spotify:track:t1"]);

    const row = await database
      .prepare(`SELECT is_liked FROM track WHERE uri = 'spotify:track:t1'`)
      .first<{ is_liked: number }>();
    expect(row?.is_liked).toBe(0);
  });
});

describe("linkTracksToKnownArtists", () => {
  test("links a track to an artist already recorded", async () => {
    await recordArtists(database, [artist("spotify:artist:pf", "Pink Floyd")], {
      isFollowed: true,
      now: NOW,
    });
    const tracks = [track("spotify:track:t1", "Echoes", [{ uri: "spotify:artist:pf", name: "Pink Floyd" }])];
    await recordTracks(database, tracks, { isLiked: true, now: NOW });

    await linkTrackRelations(database, tracks, { now: NOW });

    const row = await database
      .prepare(`SELECT COUNT(*) AS count FROM track_artist`)
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  test("links every artist on a collaboration, not just the first", async () => {
    // The multi-artist requirement: a track has many artists, and dropping
    // the second is the failure a join table exists to prevent.
    await recordArtists(
      database,
      [artist("spotify:artist:a", "Artist A"), artist("spotify:artist:b", "Artist B")],
      { isFollowed: true, now: NOW },
    );
    const tracks = [track("spotify:track:t1", "A Collaboration", [{ uri: "spotify:artist:a", name: "Artist A" }, { uri: "spotify:artist:b", name: "Artist B" }])];
    await recordTracks(database, tracks, { isLiked: true, now: NOW });

    await linkTrackRelations(database, tracks, { now: NOW });

    const row = await database
      .prepare(`SELECT COUNT(*) AS count FROM track_artist WHERE track_uri = 'spotify:track:t1'`)
      .first<{ count: number }>();
    expect(row?.count).toBe(2);
  });

  test("links an artist nobody had recorded yet, rather than dropping it", async () => {
    // This replaces a test that asserted the opposite. Linking used to match
    // on display name and could only reach artists already recorded, so every
    // track by an unfollowed artist lost its link silently — which is most of
    // a 2,282-track library. Spotify sends the artist id on every track; the
    // mapper was discarding it.
    const tracks = [
      track("spotify:track:t1", "Echoes", [
        { uri: "spotify:artist:unfollowed", name: "Someone Unfollowed" },
      ]),
    ];
    await recordTracks(database, tracks, { isLiked: true, now: NOW });

    await linkTrackRelations(database, tracks, { now: NOW });

    const link = await database
      .prepare(`SELECT COUNT(*) AS count FROM track_artist`)
      .first<{ count: number }>();
    expect(link?.count).toBe(1);

    // Recorded as NOT followed: appearing on a liked track says nothing
    // about whether the user follows them.
    const artistRow = await database
      .prepare(`SELECT is_followed FROM artist WHERE uri = 'spotify:artist:unfollowed'`)
      .first<{ is_followed: number }>();
    expect(artistRow?.is_followed).toBe(0);
  });
});

describe("end to end: reading a library produces real coverage", () => {
  test("liked tracks read after following an artist give that artist a count", async () => {
    // The whole point, in one test. Nothing here touches the fact tables
    // directly — only the two reads a user would make.
    const provider = {
      name: "spotify",
      async getFollowedArtists(): Promise<Page<Artist>> {
        return { items: [artist("spotify:artist:pf", "Pink Floyd")], nextCursor: null, total: 1 };
      },
      async getLikedTracks(): Promise<Page<Track>> {
        return {
          items: [
            track("spotify:track:t1", "Echoes", [{ uri: "spotify:artist:pf", name: "Pink Floyd" }]),
            track("spotify:track:t2", "One of These Days", [{ uri: "spotify:artist:pf", name: "Pink Floyd" }]),
          ],
          nextCursor: null,
          total: 2,
        };
      },
    } as unknown as MediaProvider;

    const cached = new CachedMediaProvider(provider, database, () => NOW);

    await cached.getFollowedArtists();
    await cached.getLikedTracks();
    const artists = await cached.getFollowedArtists();

    expect(artists.items[0].likedTrackCount).toBe(2);
    expect(artists.items[0].hasAnyLiked).toBe(true);
  });

  test("coverage is still zero before any liked tracks have been read", async () => {
    // Honest zero, not a wrong number: an artist followed but whose library
    // has never been read genuinely has no recorded liked tracks.
    const provider = {
      name: "spotify",
      async getFollowedArtists(): Promise<Page<Artist>> {
        return { items: [artist("spotify:artist:pf", "Pink Floyd")], nextCursor: null, total: 1 };
      },
    } as unknown as MediaProvider;

    const page = await new CachedMediaProvider(provider, database, () => NOW).getFollowedArtists();

    expect(page.items[0].likedTrackCount).toBe(0);
    expect(page.items[0].hasAnyLiked).toBe(false);
  });

  test("an unfollowed artist still gets real coverage from liked tracks", async () => {
    // The case the name-matching version got wrong, and the common one: most
    // of a 2,282-track library is by artists the user has never followed.
    // Their coverage must still count.
    const provider = {
      name: "spotify",
      async getLikedTracks(): Promise<Page<Track>> {
        return {
          items: [
            track("spotify:track:t1", "A Song", [
              { uri: "spotify:artist:never-followed", name: "Never Followed" },
            ]),
          ],
          nextCursor: null,
          total: 1,
        };
      },
    } as unknown as MediaProvider;

    await new CachedMediaProvider(provider, database, () => NOW).getLikedTracks();

    const row = await database
      .prepare(
        `SELECT liked_track_count, has_any_liked FROM artist_coverage
           WHERE artist_uri = 'spotify:artist:never-followed'`,
      )
      .first<{ liked_track_count: number; has_any_liked: number }>();
    expect(row?.liked_track_count).toBe(1);
    expect(row?.has_any_liked).toBe(1);
  });
});

describe("queuing denominator work", () => {
  test("reading followed artists queues their totals at the followed tier", async () => {
    const provider = {
      name: "spotify",
      async getFollowedArtists(): Promise<Page<Artist>> {
        return { items: [artist("spotify:artist:pf", "Pink Floyd")], nextCursor: null, total: 1 };
      },
    } as unknown as MediaProvider;

    await new CachedMediaProvider(provider, database, () => NOW).getFollowedArtists();

    const { results } = await database
      .prepare(`SELECT kind, priority FROM resolution_queue ORDER BY kind`)
      .all<{ kind: string; priority: number }>();
    expect(results?.map((row) => row.kind)).toEqual([
      "artist-album-count",
      "artist-track-count",
    ]);
    expect(results?.every((row) => row.priority === RESOLUTION_PRIORITY.FOLLOWED_ARTIST)).toBe(true);
  });

  test("an artist already resolved is not queued again", async () => {
    // Without this a library re-read re-queues every artist every time, and
    // the queue never empties.
    await database
      .prepare(
        `INSERT INTO artist VALUES ('spotify:artist:pf','pf','Pink Floyd','[]',1,120,10,?)`,
      )
      .bind(NOW)
      .run();
    const provider = {
      name: "spotify",
      async getFollowedArtists(): Promise<Page<Artist>> {
        return { items: [artist("spotify:artist:pf", "Pink Floyd")], nextCursor: null, total: 1 };
      },
    } as unknown as MediaProvider;

    await new CachedMediaProvider(provider, database, () => NOW).getFollowedArtists();

    const row = await database
      .prepare(`SELECT COUNT(*) AS count FROM resolution_queue`)
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  test("an artist met on a liked track is queued below a followed one", async () => {
    const provider = {
      name: "spotify",
      async getLikedTracks(): Promise<Page<Track>> {
        return {
          items: [
            track("spotify:track:t1", "A Song", [
              { uri: "spotify:artist:unfollowed", name: "Never Followed" },
            ]),
          ],
          nextCursor: null,
          total: 1,
        };
      },
    } as unknown as MediaProvider;

    await new CachedMediaProvider(provider, database, () => NOW).getLikedTracks();

    const row = await database
      .prepare(
        `SELECT priority FROM resolution_queue WHERE subject_uri = 'spotify:artist:unfollowed' LIMIT 1`,
      )
      .first<{ priority: number }>();
    expect(row?.priority).toBe(RESOLUTION_PRIORITY.HAS_LIKED_TRACKS);
  });
});
