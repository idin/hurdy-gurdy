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

/**
 * Most items one `POST /playlists/{id}/items` call accepts.
 *
 * Spotify's own documented cap, not a chosen number: "A maximum of 100 items
 * can be added in one request."
 */
export const PLAYLIST_ADD_MAX_ITEMS = 100;

/**
 * Most URIs one `PUT`/`DELETE /me/library` call accepts.
 *
 * Spotify's documented cap for the consolidated library endpoint, and lower
 * than the playlist cap — 40, not 100. Sending more fails the whole request,
 * so callers batch.
 */
export const LIBRARY_WRITE_MAX_ITEMS = 40;

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
  /**
   * How many tracks the album has, carried on the album object itself.
   *
   * Optional because a simplified album — the form nested inside a track —
   * does not always include it. This is why an album's coverage denominator
   * is free while an artist's needs a crawl.
   */
  total_tracks?: number;
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
  /**
   * The track-count summary, which Spotify does **not** always send.
   *
   * Its reference page for `GET /me/playlists` documents a populated
   * `tracks: { href, total }`, but as of 2026-09-13 the live endpoint
   * returns `tracks: null` for every playlist — observed across all 50
   * items of the first page of a real account. Typing it as always-present
   * is what crashed `get_playlists` on its first real use.
   */
  tracks: { total: number } | null;
  uri: string;
};

/** A device Spotify Connect can play to. */
export type SpotifyDevice = {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
};

/** What is playing right now, and where. */
export type SpotifyPlaybackState = {
  is_playing: boolean;
  progress_ms: number | null;
  item: SpotifyTrack | null;
  device?: SpotifyDevice;
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
   * Send a write request, optionally with a JSON body and query parameters.
   *
   * Separate from `get` rather than folded into it because the response
   * handling genuinely differs: Spotify's write endpoints answer `200`, `201`
   * or `204`, and a `204` has no body at all. Parsing unconditionally, as
   * `get` does, would throw on exactly the successful calls.
   *
   * @param method - `PUT`, `POST` or `DELETE`.
   * @param path - API path below `/v1`.
   * @param options.body - JSON body, when the endpoint takes one.
   * @param options.params - Query parameters, when the endpoint takes them.
   * @returns The parsed body, or null when the response carried none.
   */
  private async write<Result>(
    method: "PUT" | "POST" | "DELETE",
    path: string,
    options: {
      body?: unknown;
      params?: Record<string, string | number | undefined>;
    } = {},
  ): Promise<Result | null> {
    const url = new URL(`${SPOTIFY_API_BASE}${path}`);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

    const text = await response.text();
    return text.length === 0 ? null : (JSON.parse(text) as Result);
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

  /**
   * GET /v1/playlists/{id}/items — every track in one playlist.
   * Scope: playlist-read-private.
   *
   * `/tracks` is the deprecated form of this endpoint as of Spotify's
   * February 2026 migration: the path became `/items`, and the item's field
   * holding the track object was renamed from `track` to `item`. Verified
   * directly against Spotify's own reference page
   * (get-playlists-items) before writing this, not assumed from the older
   * form still used elsewhere.
   */
  async getPlaylistTracks(
    playlistId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<SpotifyPagingObject<{ item: SpotifyTrack }>> {
    return this.get(`/playlists/${playlistId}/items`, {
      limit: options.limit,
      offset: options.offset,
    });
  }

  /**
   * POST /v1/playlists/{id}/items — add tracks to a playlist.
   * Scope: playlist-modify-public / playlist-modify-private.
   *
   * `/items`, not the deprecated `/tracks`, per the same February 2026
   * migration that renamed the read endpoint. Verified against Spotify's
   * add-items-to-playlist reference on 2026-09-13.
   *
   * @param playlistId - The playlist to add to.
   * @param uris - Track or episode URIs. At most `PLAYLIST_ADD_MAX_ITEMS`.
   * @param options.position - Zero-based insertion index. Appends when absent.
   */
  async addPlaylistItems(
    playlistId: string,
    uris: string[],
    options: { position?: number } = {},
  ): Promise<{ snapshot_id: string } | null> {
    return this.write("POST", `/playlists/${playlistId}/items`, {
      body: { uris, ...(options.position === undefined ? {} : { position: options.position }) },
    });
  }

  /**
   * DELETE /v1/playlists/{id}/items — remove tracks from a playlist.
   * Scope: playlist-modify-public / playlist-modify-private.
   *
   * Irreversible: Spotify offers no undo, and the removed tracks are not
   * recoverable through the API. Guarded by two-step confirmation at the
   * tool layer.
   */
  async removePlaylistItems(
    playlistId: string,
    uris: string[],
  ): Promise<{ snapshot_id: string } | null> {
    return this.write("DELETE", `/playlists/${playlistId}/items`, {
      body: { tracks: uris.map((uri) => ({ uri })) },
    });
  }

  /**
   * POST /v1/users/{id}/playlists — create a playlist.
   * Scope: playlist-modify-public / playlist-modify-private.
   */
  async createPlaylist(
    userId: string,
    details: { name: string; description?: string; public?: boolean },
  ): Promise<SpotifyPlaylist | null> {
    return this.write("POST", `/users/${userId}/playlists`, { body: details });
  }

  /**
   * PUT /v1/playlists/{id} — rename a playlist or change its description
   * or visibility. Scope: playlist-modify-public / playlist-modify-private.
   */
  async updatePlaylistDetails(
    playlistId: string,
    details: { name?: string; description?: string; public?: boolean },
  ): Promise<null> {
    return this.write("PUT", `/playlists/${playlistId}`, { body: details });
  }

  /**
   * PUT /v1/me/library — save tracks, albums, shows or episodes.
   * Scope: user-library-modify.
   *
   * The consolidated endpoint that replaced the per-type `/me/tracks` and
   * `/me/albums` routes in Spotify's February 2026 migration. Takes URIs as
   * a **query parameter**, not a JSON body, which is unlike every other
   * write endpoint here — verified against the save-library-items reference
   * on 2026-09-13.
   *
   * @param uris - Spotify URIs of any saveable type. At most
   *   `LIBRARY_WRITE_MAX_ITEMS`.
   */
  async saveToLibrary(uris: string[]): Promise<null> {
    return this.write("PUT", "/me/library", { params: { uris: uris.join(",") } });
  }

  /**
   * DELETE /v1/me/library — unsave tracks, albums, shows or episodes.
   * Scope: user-library-modify.
   *
   * Irreversible in the sense that matters: an unsaved track loses its
   * "added at" date, so re-saving does not restore its place in the library.
   * Guarded by two-step confirmation at the tool layer.
   */
  async removeFromLibrary(uris: string[]): Promise<null> {
    return this.write("DELETE", "/me/library", { params: { uris: uris.join(",") } });
  }

  /** GET /v1/me/player/currently-playing. Scope: user-read-currently-playing. */
  async getCurrentlyPlaying(): Promise<SpotifyPlaybackState | null> {
    return this.get("/me/player/currently-playing", {});
  }

  /**
   * GET /v1/me — the authenticated user's profile.
   *
   * Needed because creating a playlist posts to `/users/{id}/playlists`, and
   * the id has to come from somewhere. Spotify has no "me" alias for that
   * path.
   */
  async getCurrentUser(): Promise<{ id: string; display_name: string | null }> {
    return this.get("/me", {});
  }

  /** GET /v1/me/player/devices — every device Spotify Connect can reach. Scope: user-read-playback-state. */
  async getDevices(): Promise<{ devices: SpotifyDevice[] }> {
    return this.get("/me/player/devices", {});
  }

  /**
   * PUT /v1/me/player/play — start or resume playback.
   * Scope: user-modify-playback-state. **Premium only.**
   *
   * A single track plays via `uris`; an album, artist or playlist plays via
   * `context_uri`. Passing the wrong one for the URI type is the common
   * mistake, so `SpotifyProvider.play` decides which from the URI itself
   * rather than leaving it to the caller.
   *
   * @param options.deviceId - Target device. The active device when absent —
   *   and the call fails when there is no active device.
   */
  async play(options: {
    contextUri?: string;
    uris?: string[];
    deviceId?: string;
    positionMs?: number;
  } = {}): Promise<null> {
    const body: Record<string, unknown> = {};
    if (options.contextUri !== undefined) {
      body.context_uri = options.contextUri;
    }
    if (options.uris !== undefined) {
      body.uris = options.uris;
    }
    if (options.positionMs !== undefined) {
      body.position_ms = options.positionMs;
    }
    return this.write("PUT", "/me/player/play", {
      body: Object.keys(body).length === 0 ? undefined : body,
      params: { device_id: options.deviceId },
    });
  }

  /** PUT /v1/me/player/pause. Scope: user-modify-playback-state. Premium only. */
  async pause(options: { deviceId?: string } = {}): Promise<null> {
    return this.write("PUT", "/me/player/pause", { params: { device_id: options.deviceId } });
  }

  /** POST /v1/me/player/next. Scope: user-modify-playback-state. Premium only. */
  async skipToNext(options: { deviceId?: string } = {}): Promise<null> {
    return this.write("POST", "/me/player/next", { params: { device_id: options.deviceId } });
  }

  /** POST /v1/me/player/previous. Scope: user-modify-playback-state. Premium only. */
  async skipToPrevious(options: { deviceId?: string } = {}): Promise<null> {
    return this.write("POST", "/me/player/previous", { params: { device_id: options.deviceId } });
  }

  /**
   * PUT /v1/me/player — move playback to another device.
   * Scope: user-modify-playback-state. Premium only.
   *
   * @param deviceId - The device to move to.
   * @param options.play - Start playing on arrival rather than preserving
   *   the current paused/playing state.
   */
  async transferPlayback(
    deviceId: string,
    options: { play?: boolean } = {},
  ): Promise<null> {
    return this.write("PUT", "/me/player", {
      body: { device_ids: [deviceId], ...(options.play === undefined ? {} : { play: options.play }) },
    });
  }
}
