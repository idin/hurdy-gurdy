import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";

import { CachedMediaProvider } from "../../src/cache/cached_media_provider";
import { prepareMediaCache } from "../../src/cache/media_cache_store";
import {
  forgetLikedTracks,
  linkTracksToKnownArtists,
  recordArtists,
  recordTracks,
} from "../../src/cache/record_library_facts";
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

function track(uri: string, name: string, artistNames: string[]): Track {
  return {
    uri,
    inLibrary: true,
    id: uri.split(":").pop()!,
    name,
    artistNames,
    albumName: "Meddle",
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
    await recordTracks(database, [track("spotify:track:t1", "Echoes", ["Pink Floyd"])], {
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
    const tracks = [track("spotify:track:t1", "Echoes", ["Pink Floyd"])];
    await recordTracks(database, tracks, { isLiked: true, now: NOW });

    await linkTracksToKnownArtists(database, tracks);

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
    const tracks = [track("spotify:track:t1", "A Collaboration", ["Artist A", "Artist B"])];
    await recordTracks(database, tracks, { isLiked: true, now: NOW });

    await linkTracksToKnownArtists(database, tracks);

    const row = await database
      .prepare(`SELECT COUNT(*) AS count FROM track_artist WHERE track_uri = 'spotify:track:t1'`)
      .first<{ count: number }>();
    expect(row?.count).toBe(2);
  });

  test("an artist nobody has recorded is skipped, not invented", async () => {
    const tracks = [track("spotify:track:t1", "Echoes", ["Nobody Knows Them"])];
    await recordTracks(database, tracks, { isLiked: true, now: NOW });

    await linkTracksToKnownArtists(database, tracks);

    const row = await database
      .prepare(`SELECT COUNT(*) AS count FROM track_artist`)
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
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
            track("spotify:track:t1", "Echoes", ["Pink Floyd"]),
            track("spotify:track:t2", "One of These Days", ["Pink Floyd"]),
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
});
