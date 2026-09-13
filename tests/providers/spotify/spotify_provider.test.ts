import { describe, expect, test, vi } from "vitest";

import { SpotifyProvider } from "../../../src/providers/spotify/spotify_provider";

/**
 * Fakes `fetch` with real Spotify Web API response shapes, copied from
 * Spotify's own published reference examples rather than invented — what is
 * under test here is `SpotifyProvider`'s mapping from those shapes onto
 * `MediaProvider`, not Spotify's API itself, which is exercised for real
 * once integration credentials exist.
 */
function fakeSpotifyFetch(responseBody: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 })) as unknown as typeof fetch;
}

const SAVED_TRACKS_RESPONSE = {
  href: "https://api.spotify.com/v1/me/tracks?offset=0&limit=1",
  limit: 1,
  next: "https://api.spotify.com/v1/me/tracks?offset=1&limit=1",
  offset: 0,
  previous: null,
  total: 2,
  items: [
    {
      added_at: "2026-01-01T00:00:00Z",
      track: {
        id: "track-1",
        name: "Karma Police",
        artists: [{ id: "artist-1", name: "Radiohead" }],
        album: { id: "album-1", name: "OK Computer" },
        duration_ms: 261973,
        uri: "spotify:track:track-1",
      },
    },
  ],
};

const FOLLOWED_ARTISTS_RESPONSE = {
  artists: {
    href: "https://api.spotify.com/v1/me/following?type=artist",
    limit: 1,
    next: "https://api.spotify.com/v1/me/following?type=artist&after=artist-1",
    cursors: { after: "artist-1" },
    total: 2,
    items: [
      {
        id: "artist-1",
        name: "Rammstein",
        genres: ["neue deutsche härte", "industrial metal"],
        uri: "spotify:artist:artist-1",
        images: [],
      },
    ],
  },
};

/**
 * Copied from what `GET /v1/me/playlists` actually returned for Idin's
 * account on 2026-09-13, not from Spotify's reference example.
 *
 * The difference is the bug: the documented example shows a populated
 * `tracks: { href, total }` summary, and the live endpoint returns
 * `tracks: null` for every playlist. A fixture written from the docs passes
 * while the deployed server throws, which is exactly what happened.
 */
const PLAYLISTS_RESPONSE_WITHOUT_TRACK_SUMMARY = {
  href: "https://api.spotify.com/v1/me/playlists?offset=0&limit=2",
  limit: 2,
  next: "https://api.spotify.com/v1/me/playlists?offset=2&limit=2",
  offset: 0,
  previous: null,
  total: 131,
  items: [
    {
      id: "playlist-1",
      name: "R: Pink Floyd",
      owner: { id: "idin.k", display_name: "idin.k" },
      tracks: null,
      uri: "spotify:playlist:playlist-1",
    },
    {
      id: "playlist-2",
      name: "H8: Rammstein",
      owner: { id: "idin.k", display_name: null },
      tracks: null,
      uri: "spotify:playlist:playlist-2",
    },
  ],
};

describe("SpotifyProvider.getPlaylists", () => {
  test("survives Spotify omitting the tracks summary", async () => {
    // Regression: every call failed with "Cannot read properties of
    // undefined (reading 'total')" because toPlaylist read
    // playlist.tracks.total unguarded. See
    // docs/bugs/unresolved/2026-09-13_get_playlists_crashes_when_spotify_omits_the_tracks_summary.md
    globalThis.fetch = fakeSpotifyFetch(PLAYLISTS_RESPONSE_WITHOUT_TRACK_SUMMARY);
    const provider = new SpotifyProvider("test-token");

    const page = await provider.getPlaylists();

    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(131);
  });

  test("reports an unknown track count as null, never as zero", async () => {
    // null and 0 are different claims. A playlist whose count Spotify did
    // not report is not a playlist with no tracks.
    globalThis.fetch = fakeSpotifyFetch(PLAYLISTS_RESPONSE_WITHOUT_TRACK_SUMMARY);
    const provider = new SpotifyProvider("test-token");

    const page = await provider.getPlaylists();

    expect(page.items[0].trackCount).toBeNull();
  });

  test("falls back to the owner id when display_name is null", async () => {
    globalThis.fetch = fakeSpotifyFetch(PLAYLISTS_RESPONSE_WITHOUT_TRACK_SUMMARY);
    const provider = new SpotifyProvider("test-token");

    const page = await provider.getPlaylists();

    expect(page.items[0].ownerName).toBe("idin.k");
    expect(page.items[1].ownerName).toBe("idin.k");
  });

  test("still reports a real track count when Spotify does send one", async () => {
    // The near-miss: the fix must not discard a count that is present.
    globalThis.fetch = fakeSpotifyFetch({
      ...PLAYLISTS_RESPONSE_WITHOUT_TRACK_SUMMARY,
      items: [
        {
          ...PLAYLISTS_RESPONSE_WITHOUT_TRACK_SUMMARY.items[0],
          tracks: { total: 42 },
        },
      ],
    });
    const provider = new SpotifyProvider("test-token");

    const page = await provider.getPlaylists();

    expect(page.items[0].trackCount).toBe(42);
  });
});

describe("SpotifyProvider.getLikedTracks", () => {
  test("maps a Spotify saved-tracks page onto the shared Track shape", async () => {
    globalThis.fetch = fakeSpotifyFetch(SAVED_TRACKS_RESPONSE);
    const provider = new SpotifyProvider("test-token");

    const page = await provider.getLikedTracks();

    expect(page.items).toEqual([
      {
        id: "track-1",
        name: "Karma Police",
        artists: [{ uri: "spotify:artist:artist-1", name: "Radiohead" }],
        artistNames: ["Radiohead"],
        albumName: "OK Computer",
        albumUri: "spotify:album:album-1",
        durationMs: 261973,
        uri: "spotify:track:track-1",
        // A liked track IS the library for tracks — Liked Songs and saved
        // tracks are the same store, so membership holds by construction.
        inLibrary: true,
      },
    ]);
    expect(page.total).toBe(2);
  });

  test("a present next URL becomes a non-null offset cursor", async () => {
    globalThis.fetch = fakeSpotifyFetch(SAVED_TRACKS_RESPONSE);
    const provider = new SpotifyProvider("test-token");

    const page = await provider.getLikedTracks();

    // offset 0 + 1 item returned = next offset 1, as a string cursor.
    expect(page.nextCursor).toBe("1");
  });

  test("a null next URL means no more pages", async () => {
    globalThis.fetch = fakeSpotifyFetch({ ...SAVED_TRACKS_RESPONSE, next: null });
    const provider = new SpotifyProvider("test-token");

    const page = await provider.getLikedTracks();

    expect(page.nextCursor).toBeNull();
  });
});

describe("SpotifyProvider.getFollowedArtists", () => {
  test("maps a cursor-paginated response onto the shared Page shape", async () => {
    globalThis.fetch = fakeSpotifyFetch(FOLLOWED_ARTISTS_RESPONSE);
    const provider = new SpotifyProvider("test-token");

    const page = await provider.getFollowedArtists();

    expect(page.items).toEqual([
      {
        id: "artist-1",
        name: "Rammstein",
        genres: ["neue deutsche härte", "industrial metal"],
        uri: "spotify:artist:artist-1",
        // Followed, so in the library by construction.
        inLibrary: true,
        // Coverage counts need the cached liked tracks, which do not exist
        // yet. The shape is final; only the values will change.
        likedTrackCount: 0,
        totalTrackCount: null,
        hasAnyLiked: false,
        albumsWithLikedTracks: 0,
        totalAlbumCount: null,
      },
    ]);
    // Cursor-paginated, so the cursor is Spotify's own `after` value, not a
    // derived offset — this is the one place the two pagination styles this
    // package wraps must not be conflated.
    expect(page.nextCursor).toBe("artist-1");
    expect(page.total).toBe(2);
  });
});

describe("SpotifyProvider.getPlaylistTracks", () => {
  const PLAYLIST_ITEMS_RESPONSE = {
    href: "https://api.spotify.com/v1/playlists/playlist-1/items?offset=0&limit=1",
    limit: 1,
    next: null,
    offset: 0,
    previous: null,
    total: 1,
    items: [
      {
        added_at: "2026-01-01T00:00:00Z",
        item: {
          id: "track-1",
          name: "Karma Police",
          artists: [{ id: "artist-1", name: "Radiohead" }],
          album: { id: "album-1", name: "OK Computer" },
          duration_ms: 261973,
          uri: "spotify:track:track-1",
        },
      },
    ],
  };

  test("requests /playlists/{id}/items, not the deprecated /tracks path", async () => {
    // Spotify's February 2026 migration renamed GET /playlists/{id}/tracks
    // to GET /playlists/{id}/items, and the item field from `track` to
    // `item`. Asserted on the actual request URL, not just the mapped
    // output, because a test that only checks the output can pass against
    // a stale path if the fake response is shaped to match it regardless.
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify(PLAYLIST_ITEMS_RESPONSE), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const provider = new SpotifyProvider("test-token");

    await provider.getPlaylistTracks("playlist-1");

    const requestedUrl = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0][0] as URL;
    expect(requestedUrl.pathname).toBe("/v1/playlists/playlist-1/items");
    expect(requestedUrl.pathname).not.toContain("/tracks");
  });

  test("maps the item field (not the deprecated track field) onto Track", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(PLAYLIST_ITEMS_RESPONSE), { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = new SpotifyProvider("test-token");

    const page = await provider.getPlaylistTracks("playlist-1");

    expect(page.items).toEqual([
      {
        id: "track-1",
        name: "Karma Police",
        artists: [{ uri: "spotify:artist:artist-1", name: "Radiohead" }],
        artistNames: ["Radiohead"],
        albumName: "OK Computer",
        albumUri: "spotify:album:album-1",
        durationMs: 261973,
        uri: "spotify:track:track-1",
        // FALSE, deliberately. A track in a playlist is not necessarily
        // liked — playlist membership and library membership are independent
        // in Spotify, so this endpoint cannot assume either way.
        inLibrary: false,
      },
    ]);
  });
});

describe("SpotifyProvider.search", () => {
  test("only requested types are present, others come back as empty pages", async () => {
    globalThis.fetch = fakeSpotifyFetch({
      tracks: {
        href: "",
        limit: 10,
        next: null,
        offset: 0,
        previous: null,
        total: 0,
        items: [],
      },
    });
    const provider = new SpotifyProvider("test-token");

    const result = await provider.search("test query", { types: ["track"] });

    expect(result.tracks.items).toEqual([]);
    expect(result.artists).toEqual({ items: [], nextCursor: null, total: 0 });
    expect(result.albums).toEqual({ items: [], nextCursor: null, total: 0 });
    expect(result.playlists).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  test("the query reaches the request", async () => {
    const fetchSpy = fakeSpotifyFetch({
      tracks: { href: "", limit: 10, next: null, offset: 0, previous: null, total: 0, items: [] },
    });
    globalThis.fetch = fetchSpy;
    const provider = new SpotifyProvider("test-token");

    await provider.search("artist:Radiohead track:Karma Police");

    const requestedUrl = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0][0] as URL;
    expect(requestedUrl.searchParams.get("q")).toBe("artist:Radiohead track:Karma Police");
  });
});
