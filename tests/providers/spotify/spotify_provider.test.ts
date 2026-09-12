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

describe("SpotifyProvider.getLikedTracks", () => {
  test("maps a Spotify saved-tracks page onto the shared Track shape", async () => {
    globalThis.fetch = fakeSpotifyFetch(SAVED_TRACKS_RESPONSE);
    const provider = new SpotifyProvider("test-token");

    const page = await provider.getLikedTracks();

    expect(page.items).toEqual([
      {
        id: "track-1",
        name: "Karma Police",
        artistNames: ["Radiohead"],
        albumName: "OK Computer",
        durationMs: 261973,
        uri: "spotify:track:track-1",
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
      },
    ]);
    // Cursor-paginated, so the cursor is Spotify's own `after` value, not a
    // derived offset — this is the one place the two pagination styles this
    // package wraps must not be conflated.
    expect(page.nextCursor).toBe("artist-1");
    expect(page.total).toBe(2);
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
