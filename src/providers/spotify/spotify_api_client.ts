/**
 * Raw HTTP calls against the Spotify Web API.
 *
 * Kept separate from `SpotifyProvider` (which maps these responses onto the
 * shared `MediaProvider` shape) so the two concerns — "what Spotify's API
 * actually returns" and "what this package promises callers" — can each be
 * read and tested on their own.
 */

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

/** The maximum `limit` Spotify's search endpoint accepts, per item type. */
export const SEARCH_MAX_LIMIT = 10;

/** The maximum `limit` Spotify's library-listing endpoints accept. */
export const LIBRARY_MAX_LIMIT = 50;

/** One page of a Spotify "paging object" response, generic over item shape. */
export type SpotifyPagingObject<Item> = {
  href: string;
  limit: number;
  next: string | null;
  offset: number;
  previous: string | null;
  total: number;
  items: Item[];
};

/** One page of a Spotify cursor-paginated response (used for followed artists). */
export type SpotifyCursorPage<Item> = {
  href: string;
  limit: number;
  next: string | null;
  cursors: { after: string | null; before?: string };
  total: number;
  items: Item[];
};

export type SpotifyImage = { url: string; height: number | null; width: number | null };

export type SpotifyArtist = {
  id: string;
  name: string;
  genres: string[];
  uri: string;
  images: SpotifyImage[];
};

export type SpotifyAlbum = {
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  release_date: string;
  uri: string;
  images: SpotifyImage[];
};

export type SpotifyTrack = {
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  album: { id: string; name: string };
  duration_ms: number;
  uri: string;
};

export type SpotifyPlaylist = {
  id: string;
  name: string;
  owner: { id: string; display_name: string | null };
  tracks: { total: number };
  uri: string;
};

/** Thrown when Spotify's API returns a non-2xx response. */
export class SpotifyApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(options: { status: number; body: string; retryAfterSeconds: number | null }) {
    super(`Spotify API returned ${options.status}: ${options.body}`);
    this.name = "SpotifyApiError";
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Whether an error means Spotify is rate-limiting rather than rejecting the request. */
export function isSpotifyRateLimited(error: unknown): boolean {
  return error instanceof SpotifyApiError && error.status === 429;
}

/**
 * A thin client for the Spotify Web API, authenticated with one access
 * token.
 *
 * Holds no OAuth state of its own — refreshing the token and constructing a
 * new client with the fresh one is the caller's job, kept in
 * `spotify_oauth.ts` so this file only ever has to reason about the Web API
 * itself.
 */
export class SpotifyApiClient {
  private readonly accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async get<Result>(path: string, params: Record<string, string | number | undefined>): Promise<Result> {
    const url = new URL(`${SPOTIFY_API_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) {
      const body = await response.text();
      const retryAfterHeader = response.headers.get("Retry-After");
      throw new SpotifyApiError({
        status: response.status,
        body,
        retryAfterSeconds: retryAfterHeader ? Number(retryAfterHeader) : null,
      });
    }

    return (await response.json()) as Result;
  }

  /**
   * GET /v1/search.
   *
   * @param query - Free-text query, or one using Spotify's field filters
   *   (`artist:`, `track:`, `album:`, `year:`, `genre:`).
   * @param types - Which item types to search. Spotify allows more types
   *   than this package models; only the four `MediaProvider` covers are
   *   accepted here.
   * @param options.limit - Per-type result count. Spotify's own ceiling is
   *   {@link SEARCH_MAX_LIMIT} — much lower than the library endpoints.
   * @param options.offset - Starting index, for paging past the limit.
   */
  async search(
    query: string,
    types: Array<"track" | "artist" | "album" | "playlist">,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{
    tracks?: SpotifyPagingObject<SpotifyTrack>;
    artists?: SpotifyPagingObject<SpotifyArtist>;
    albums?: SpotifyPagingObject<SpotifyAlbum>;
    playlists?: SpotifyPagingObject<SpotifyPlaylist>;
  }> {
    return this.get("/search", {
      q: query,
      type: types.join(","),
      limit: options.limit,
      offset: options.offset,
    });
  }

  /** GET /v1/me/tracks — the user's liked songs. Scope: user-library-read. */
  async getSavedTracks(
    options: { limit?: number; offset?: number } = {},
  ): Promise<SpotifyPagingObject<{ added_at: string; track: SpotifyTrack }>> {
    return this.get("/me/tracks", { limit: options.limit, offset: options.offset });
  }

  /** GET /v1/me/albums — the user's saved albums. Scope: user-library-read. */
  async getSavedAlbums(
    options: { limit?: number; offset?: number } = {},
  ): Promise<SpotifyPagingObject<{ added_at: string; album: SpotifyAlbum }>> {
    return this.get("/me/albums", { limit: options.limit, offset: options.offset });
  }

  /**
   * GET /v1/me/following?type=artist — the artists the user follows.
   * Scope: user-follow-read. Cursor-paginated, not offset-paginated — see
   * {@link SpotifyCursorPage}.
   */
  async getFollowedArtists(
    options: { limit?: number; after?: string } = {},
  ): Promise<{ artists: SpotifyCursorPage<SpotifyArtist> }> {
    return this.get("/me/following", {
      type: "artist",
      limit: options.limit,
      after: options.after,
    });
  }

  /** GET /v1/me/playlists — playlists the user owns or follows. Scope: playlist-read-private. */
  async getPlaylists(
    options: { limit?: number; offset?: number } = {},
  ): Promise<SpotifyPagingObject<SpotifyPlaylist>> {
    return this.get("/me/playlists", { limit: options.limit, offset: options.offset });
  }

  /** GET /v1/playlists/{id}/tracks — every track in one playlist. Scope: playlist-read-private. */
  async getPlaylistTracks(
    playlistId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<SpotifyPagingObject<{ track: SpotifyTrack }>> {
    return this.get(`/playlists/${playlistId}/tracks`, {
      limit: options.limit,
      offset: options.offset,
    });
  }
}
