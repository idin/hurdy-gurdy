/**
 * A `MediaProvider` that reads through a cache, and fills in coverage.
 *
 * Written as a decorator around any provider rather than inside the Spotify
 * one, so YouTube Music and Apple Music get caching by construction when they
 * arrive — the caching policy is not a Spotify fact.
 *
 * Two jobs, deliberately in one place because they share a pass over the
 * results:
 *
 * 1. **Serve from cache when possible**, so a repeated question costs nothing
 *    and a library scan is not repaid on every query.
 * 2. **Fill in coverage** — `likedTrackCount`, `hasAnyLiked`,
 *    `albumsWithLikedTracks` — which the underlying provider returns as zeros
 *    because only the cache knows what the library holds.
 *
 * **Writes are never cached and always invalidate.** Adding a track to a
 * playlist changes what a subsequent read must return, and a cache that
 * served the old answer afterwards would be worse than no cache: a wrong
 * answer nobody can explain beats a slow right one.
 */

import type {
  Album,
  Artist,
  Device,
  MediaProvider,
  NowPlaying,
  Page,
  Playlist,
  SearchType,
  Track,
} from "../providers/media_provider";
import { buildCacheKey } from "./cache_entry";
import {
  findAlbumCoverage,
  findArtistCoverage,
  findCachedResponse,
  prepareMediaCache,
  storeCachedResponse,
} from "./media_cache_store";

/** A clock, injected so cache expiry is testable without waiting 66 days. */
export type Clock = () => number;

/**
 * Wrap a provider so its reads are cached and its results carry coverage.
 *
 * @param inner - The provider doing the real work.
 * @param database - Where the cache lives.
 * @param now - Current time. Injected rather than read from `Date.now`
 *   directly so expiry behaviour can be tested.
 */
export class CachedMediaProvider implements MediaProvider {
  readonly name: string;
  private readonly inner: MediaProvider;
  private readonly database: D1Database;
  private readonly now: Clock;

  constructor(inner: MediaProvider, database: D1Database, now: Clock = () => Date.now()) {
    this.inner = inner;
    this.database = database;
    this.now = now;
    this.name = inner.name;
  }

  /**
   * Serve a page from cache, or fetch and store it.
   *
   * A cache failure is swallowed and the fetch runs anyway: the cache is an
   * optimisation, and a database problem must not take out the tools. A
   * *stale* entry is treated as a miss here rather than revalidated, because
   * revalidation needs the provider to send a conditional request and this
   * layer does not have one — that is `freshness_check.ts`'s job, wired in at
   * the client.
   */
  private async readThrough<Item>(
    method: string,
    parameters: Record<string, string | number | undefined>,
    fetchPage: () => Promise<Page<Item>>,
  ): Promise<Page<Item>> {
    const key = buildCacheKey(this.name, method, parameters);

    try {
      await prepareMediaCache(this.database);
      const lookup = await findCachedResponse(this.database, key, this.now());
      if (lookup.state === "fresh") {
        return JSON.parse(lookup.entry.payload) as Page<Item>;
      }
    } catch {
      // Fall through to the provider. A broken cache is a slow server, not a
      // broken one.
    }

    const page = await fetchPage();

    try {
      await storeCachedResponse(
        this.database,
        { key, payload: JSON.stringify(page), etag: null, total: page.total },
        this.now(),
      );
    } catch {
      // The answer is already correct; failing to remember it is not worth
      // failing the call over.
    }

    return page;
  }

  /**
   * Replace the zeroed coverage on artists with what the cache knows.
   *
   * Artists absent from the cache keep their zeros rather than being dropped:
   * "no liked tracks recorded" and "never seen" look the same to a caller
   * here, and inventing a distinction the data cannot support would be worse
   * than the small imprecision.
   */
  private async fillArtistCoverage(page: Page<Artist>): Promise<Page<Artist>> {
    if (page.items.length === 0) {
      return page;
    }
    try {
      const coverage = await findArtistCoverage(
        this.database,
        page.items.map((artist) => artist.uri),
      );
      return {
        ...page,
        items: page.items.map((artist) => {
          const found = coverage.get(artist.uri);
          return found === undefined ? artist : { ...artist, ...found };
        }),
      };
    } catch {
      return page;
    }
  }

  /** The same, for albums. */
  private async fillAlbumCoverage(page: Page<Album>): Promise<Page<Album>> {
    if (page.items.length === 0) {
      return page;
    }
    try {
      const coverage = await findAlbumCoverage(
        this.database,
        page.items.map((album) => album.uri),
      );
      return {
        ...page,
        items: page.items.map((album) => {
          const found = coverage.get(album.uri);
          // An album's totalTrackCount comes from the provider and is better
          // than the view's copy, so it is not overwritten by a null.
          return found === undefined
            ? album
            : { ...album, ...found, totalTrackCount: album.totalTrackCount ?? found.totalTrackCount };
        }),
      };
    } catch {
      return page;
    }
  }

  // --- Reads ---------------------------------------------------------------

  async search(
    query: string,
    options: { types?: SearchType[]; limit?: number; cursor?: string } = {},
  ): Promise<{
    tracks: Page<Track>;
    artists: Page<Artist>;
    albums: Page<Album>;
    playlists: Page<Playlist>;
  }> {
    const results = await this.inner.search(query, options);
    const [artists, albums] = await Promise.all([
      this.fillArtistCoverage(results.artists),
      this.fillAlbumCoverage(results.albums),
    ]);
    return { ...results, artists, albums };
  }

  async getLikedTracks(options: { limit?: number; cursor?: string } = {}): Promise<Page<Track>> {
    return this.readThrough("getLikedTracks", { ...options }, () =>
      this.inner.getLikedTracks(options),
    );
  }

  async getFollowedArtists(
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<Artist>> {
    const page = await this.readThrough("getFollowedArtists", { ...options }, () =>
      this.inner.getFollowedArtists(options),
    );
    return this.fillArtistCoverage(page);
  }

  async getSavedAlbums(options: { limit?: number; cursor?: string } = {}): Promise<Page<Album>> {
    const page = await this.readThrough("getSavedAlbums", { ...options }, () =>
      this.inner.getSavedAlbums(options),
    );
    return this.fillAlbumCoverage(page);
  }

  async getPlaylists(options: { limit?: number; cursor?: string } = {}): Promise<Page<Playlist>> {
    return this.readThrough("getPlaylists", { ...options }, () => this.inner.getPlaylists(options));
  }

  async getPlaylistTracks(
    playlistId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<Track>> {
    return this.readThrough("getPlaylistTracks", { playlistId, ...options }, () =>
      this.inner.getPlaylistTracks(playlistId, options),
    );
  }

  // --- Writes --------------------------------------------------------------
  //
  // Never cached. Each clears the entries its change would falsify, because a
  // cache that serves a pre-write answer afterwards is worse than no cache.

  /**
   * Forget cached pages for one method.
   *
   * Coarse on purpose: a playlist edit invalidates every page of that
   * playlist, not just the page the track landed on, and working out which
   * pages shifted would be more code and more ways to be wrong than simply
   * refetching.
   */
  private async invalidate(method: string): Promise<void> {
    const base = `${this.name}:${method}`;
    try {
      await this.database
        .prepare(`DELETE FROM cached_response WHERE key = ? OR key LIKE ?`)
        .bind(base, `${base}:%`)
        // Both forms are needed. `buildCacheKey` appends parameters after a
        // colon, but a call with no parameters produces no trailing colon at
        // all — `spotify:getLikedTracks`, not `spotify:getLikedTracks:`. A
        // prefix pattern alone therefore misses exactly the unpaged call,
        // which is the most common one, and the cache would keep serving a
        // pre-write answer after every library change.
        .run();
    } catch {
      // A failed invalidation must not fail the write that already succeeded.
      // The TTL is the backstop.
    }
  }

  async addTracksToPlaylist(
    playlistId: string,
    uris: string[],
    options?: { position?: number },
  ): Promise<void> {
    await this.inner.addTracksToPlaylist!(playlistId, uris, options);
    await this.invalidate("getPlaylistTracks");
    await this.invalidate("getPlaylists");
  }

  async removeTracksFromPlaylist(playlistId: string, uris: string[]): Promise<void> {
    await this.inner.removeTracksFromPlaylist!(playlistId, uris);
    await this.invalidate("getPlaylistTracks");
    await this.invalidate("getPlaylists");
  }

  async createPlaylist(details: {
    name: string;
    description?: string;
    isPublic?: boolean;
  }): Promise<Playlist> {
    const created = await this.inner.createPlaylist!(details);
    await this.invalidate("getPlaylists");
    return created;
  }

  async updatePlaylistDetails(
    playlistId: string,
    details: { name?: string; description?: string; isPublic?: boolean },
  ): Promise<void> {
    await this.inner.updatePlaylistDetails!(playlistId, details);
    await this.invalidate("getPlaylists");
  }

  async saveToLibrary(uris: string[]): Promise<void> {
    await this.inner.saveToLibrary!(uris);
    await this.invalidateLibraryReads();
  }

  async removeFromLibrary(uris: string[]): Promise<void> {
    await this.inner.removeFromLibrary!(uris);
    await this.invalidateLibraryReads();
  }

  /**
   * Forget every library listing.
   *
   * A library write can touch tracks, albums, shows or episodes in one call —
   * the consolidated endpoint takes mixed URI types — so which listings it
   * falsified is not knowable without inspecting each URI. Clearing all three
   * is cheaper than being clever and cannot be wrong.
   */
  private async invalidateLibraryReads(): Promise<void> {
    await this.invalidate("getLikedTracks");
    await this.invalidate("getSavedAlbums");
    await this.invalidate("getFollowedArtists");
  }

  // --- Playback ------------------------------------------------------------
  //
  // Pass-through. Playback state is live by definition: a cached answer to
  // "what is playing" is a wrong answer, and the calls are cheap anyway.

  async getCurrentlyPlaying(): Promise<NowPlaying | null> {
    return this.inner.getCurrentlyPlaying!();
  }

  async listDevices(): Promise<Device[]> {
    return this.inner.listDevices!();
  }

  async play(options?: { uri?: string; deviceId?: string; deviceName?: string }): Promise<void> {
    return this.inner.play!(options);
  }

  async pause(options?: { deviceId?: string }): Promise<void> {
    return this.inner.pause!(options);
  }

  async skipToNext(options?: { deviceId?: string }): Promise<void> {
    return this.inner.skipToNext!(options);
  }

  async skipToPrevious(options?: { deviceId?: string }): Promise<void> {
    return this.inner.skipToPrevious!(options);
  }

  async transferPlayback(deviceId: string, options?: { play?: boolean }): Promise<void> {
    return this.inner.transferPlayback!(deviceId, options);
  }

  async getQueue(): Promise<{ nowPlaying: Track | null; queue: Track[] }> {
    return this.inner.getQueue!();
  }

  async addToQueue(uri: string, options?: { deviceId?: string }): Promise<void> {
    return this.inner.addToQueue!(uri, options);
  }
}
