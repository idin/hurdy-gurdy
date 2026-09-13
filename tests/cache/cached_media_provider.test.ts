import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";

import { CachedMediaProvider } from "../../src/cache/cached_media_provider";
import { prepareMediaCache } from "../../src/cache/media_cache_store";
import type { Album, Artist, MediaProvider, Page, Track } from "../../src/providers/media_provider";

/**
 * Against a real D1, because the point of this layer is what the database
 * ends up holding.
 *
 * The cases that matter most are the invalidation ones. A cache that serves a
 * pre-write answer is worse than no cache — the user sees a change they made
 * not take effect, with nothing to explain it — so every write path is tested
 * for actually clearing what it falsified.
 */

const database = (env as { MEDIA_CACHE: D1Database }).MEDIA_CACHE;
const NOW = Date.parse("2026-09-13T12:00:00Z");

function trackPage(name: string): Page<Track> {
  return {
    items: [
      {
        uri: "spotify:track:t1",
        inLibrary: true,
        id: "t1",
        name,
        artists: [{ uri: "spotify:artist:pf", name: "Pink Floyd" }],
        artistNames: ["Pink Floyd"],
        albumName: "Meddle",
        albumUri: "spotify:album:meddle",
        albumTrackCount: null,
        durationMs: 1,
        isrc: null,
      },
    ],
    nextCursor: null,
    total: 1,
  };
}

/** A provider that counts its calls, so cache hits are observable. */
function countingProvider(overrides: Partial<MediaProvider> = {}) {
  const calls: Record<string, number> = {};
  const count = (method: string) => {
    calls[method] = (calls[method] ?? 0) + 1;
  };
  const provider = {
    name: "spotify",
    async getLikedTracks() {
      count("getLikedTracks");
      return trackPage("Echoes");
    },
    async getFollowedArtists(): Promise<Page<Artist>> {
      count("getFollowedArtists");
      return {
        items: [
          {
            uri: "spotify:artist:pf",
            inLibrary: true,
            id: "pf",
            name: "Pink Floyd",
            genres: [],
            likedTrackCount: 0,
            totalTrackCount: null,
            hasAnyLiked: false,
            albumsWithLikedTracks: 0,
            totalAlbumCount: null,
          },
        ],
        nextCursor: null,
        total: 1,
      };
    },
    async getSavedAlbums(): Promise<Page<Album>> {
      count("getSavedAlbums");
      return {
        items: [
          {
            uri: "spotify:album:meddle",
            inLibrary: true,
            id: "meddle",
            name: "Meddle",
            artistNames: ["Pink Floyd"],
            releaseDate: "1971-10-31",
            likedTrackCount: 0,
            totalTrackCount: 6,
            hasAnyLiked: false,
          },
        ],
        nextCursor: null,
        total: 1,
      };
    },
    async getPlaylists() {
      count("getPlaylists");
      return { items: [], nextCursor: null, total: 0 };
    },
    async getPlaylistTracks() {
      count("getPlaylistTracks");
      return trackPage("One of These Days");
    },
    async search() {
      count("search");
      return {
        tracks: { items: [], nextCursor: null, total: 0 },
        artists: { items: [], nextCursor: null, total: 0 },
        albums: { items: [], nextCursor: null, total: 0 },
        playlists: { items: [], nextCursor: null, total: 0 },
      };
    },
    async addTracksToPlaylist() {
      count("addTracksToPlaylist");
    },
    async removeTracksFromPlaylist() {
      count("removeTracksFromPlaylist");
    },
    async saveToLibrary() {
      count("saveToLibrary");
    },
    async removeFromLibrary() {
      count("removeFromLibrary");
    },
    ...overrides,
  } as unknown as MediaProvider;
  return { provider, calls };
}

beforeEach(async () => {
  await prepareMediaCache(database);
  for (const table of ["cached_response",
    "resolution_queue", "track_artist", "playlist_track", "track", "album", "artist"]) {
    await database.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("reading through the cache", () => {
  test("a repeated read does not reach the provider twice", async () => {
    const { provider, calls } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW);

    await cached.getLikedTracks();
    await cached.getLikedTracks();

    expect(calls.getLikedTracks).toBe(1);
  });

  test("the cached answer is the same answer", async () => {
    const { provider } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW);

    const first = await cached.getLikedTracks();
    const second = await cached.getLikedTracks();

    expect(second).toEqual(first);
  });

  test("different pages are cached separately", async () => {
    const { provider, calls } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW);

    await cached.getLikedTracks({ cursor: "0" });
    await cached.getLikedTracks({ cursor: "50" });

    expect(calls.getLikedTracks).toBe(2);
  });

  test("different playlists are cached separately", async () => {
    const { provider, calls } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW);

    await cached.getPlaylistTracks("playlist-1");
    await cached.getPlaylistTracks("playlist-2");

    expect(calls.getPlaylistTracks).toBe(2);
  });

  test("a provider error is not cached as if it were an answer", async () => {
    let attempts = 0;
    const { provider } = countingProvider({
      async getPlaylists() {
        attempts += 1;
        throw new Error("Spotify is down");
      },
    });
    const cached = new CachedMediaProvider(provider, database, () => NOW);

    await expect(cached.getPlaylists()).rejects.toThrow();
    await expect(cached.getPlaylists()).rejects.toThrow();
    expect(attempts).toBe(2);
  });
});

describe("coverage from the cache", () => {
  test("an artist's zeroed coverage is replaced by what the cache knows", async () => {
    // The provider cannot know this: only the cache holds the library.
    await database
      .prepare(`INSERT INTO artist VALUES ('spotify:artist:pf','pf','Pink Floyd','[]',1,120,10,?)`)
      .bind(NOW)
      .run();
    await database
      .prepare(`INSERT INTO album (uri, id, name, release_date, total_tracks, is_saved, cached_at) VALUES ('spotify:album:meddle','m','Meddle','1971',6,0,?)`)
      .bind(NOW)
      .run();
    await database
      .prepare(`INSERT INTO track (uri, id, name, album_uri, duration_ms, is_liked, liked_at, cached_at) VALUES ('spotify:track:t1','t1','Echoes','spotify:album:meddle',1,1,NULL,?)`)
      .bind(NOW)
      .run();
    await database
      .prepare(`INSERT INTO track_artist VALUES ('spotify:track:t1','spotify:artist:pf')`)
      .run();

    const { provider } = countingProvider();
    const page = await new CachedMediaProvider(provider, database, () => NOW).getFollowedArtists();

    expect(page.items[0].likedTrackCount).toBe(1);
    expect(page.items[0].hasAnyLiked).toBe(true);
    expect(page.items[0].totalTrackCount).toBe(120);
    expect(page.items[0].albumsWithLikedTracks).toBe(1);
  });

  test("an artist the cache has never seen keeps its zeros", async () => {
    const { provider } = countingProvider();
    const page = await new CachedMediaProvider(provider, database, () => NOW).getFollowedArtists();

    expect(page.items[0].likedTrackCount).toBe(0);
    expect(page.items[0].hasAnyLiked).toBe(false);
  });

  test("the provider's album total is kept over the view's", async () => {
    // The near-miss: the view reports total_track_count from the album row,
    // and blindly spreading coverage over the item would replace a real
    // figure from the provider with a null.
    await database
      .prepare(`INSERT INTO album (uri, id, name, release_date, total_tracks, is_saved, cached_at) VALUES ('spotify:album:meddle','m','Meddle','1971',NULL,1,?)`)
      .bind(NOW)
      .run();

    const { provider } = countingProvider();
    const page = await new CachedMediaProvider(provider, database, () => NOW).getSavedAlbums();

    expect(page.items[0].totalTrackCount).toBe(6);
  });
});

describe("writes invalidate what they falsify", () => {
  test("adding to a playlist clears that playlist's cached tracks", async () => {
    // The failure this prevents: a user adds a track, reads the playlist, and
    // does not see it — with nothing to explain why.
    const { provider, calls } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW);

    await cached.getPlaylistTracks("playlist-1");
    await cached.addTracksToPlaylist("playlist-1", ["spotify:track:new"]);
    await cached.getPlaylistTracks("playlist-1");

    expect(calls.getPlaylistTracks).toBe(2);
  });

  test("removing from a playlist clears it too", async () => {
    const { provider, calls } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW);

    await cached.getPlaylistTracks("playlist-1");
    await cached.removeTracksFromPlaylist("playlist-1", ["spotify:track:t1"]);
    await cached.getPlaylistTracks("playlist-1");

    expect(calls.getPlaylistTracks).toBe(2);
  });

  test("saving to the library clears every library listing", async () => {
    // One call can save tracks, albums and shows together, so which listing
    // it falsified is not knowable without inspecting each URI.
    const { provider, calls } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW);

    await cached.getLikedTracks();
    await cached.getSavedAlbums();
    await cached.saveToLibrary(["spotify:track:new"]);
    await cached.getLikedTracks();
    await cached.getSavedAlbums();

    expect(calls.getLikedTracks).toBe(2);
    expect(calls.getSavedAlbums).toBe(2);
  });

  test("removing from the library clears them as well", async () => {
    const { provider, calls } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW);

    await cached.getLikedTracks();
    await cached.removeFromLibrary(["spotify:track:t1"]);
    await cached.getLikedTracks();

    expect(calls.getLikedTracks).toBe(2);
  });

  test("a playlist write does not clear unrelated library reads", async () => {
    // The near-miss in the other direction: over-invalidating turns every
    // write into a cold cache and quietly undoes the whole point.
    const { provider, calls } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW);

    await cached.getLikedTracks();
    await cached.addTracksToPlaylist("playlist-1", ["spotify:track:new"]);
    await cached.getLikedTracks();

    expect(calls.getLikedTracks).toBe(1);
  });
});
