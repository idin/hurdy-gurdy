/**
 * `MediaProvider` implemented against the real Spotify Web API.
 *
 * Maps Spotify's own response shapes onto the shared interface. Two of
 * Spotify's list endpoints paginate by numeric offset (saved tracks, saved
 * albums, playlists, playlist tracks) and one paginates by cursor (followed
 * artists) — `Page.nextCursor` is opaque on purpose so this difference never
 * has to leak past this file.
 */

import {
  LIBRARY_MAX_LIMIT,
  SEARCH_MAX_LIMIT,
  SpotifyApiClient,
  isNoActiveDevice,
  type SpotifyAlbum,
  type SpotifyArtist,
  type SpotifyPagingObject,
  type SpotifyPlaylist,
  type SpotifyTrack,
} from "./spotify_api_client";
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
} from "../media_provider";

/**
 * Coverage for something the library's contents have not been consulted for.
 *
 * Every mapper starts here and a caller that knows better overwrites it. The
 * numerators need the cached liked tracks, which do not exist yet, so today
 * every result carries zeros with null denominators. The **shape** is final,
 * which is the part that matters: adding the cache later fills these in
 * without any consumer seeing a different set of fields.
 */
const UNCOUNTED_COVERAGE = {
  likedTrackCount: 0,
  totalTrackCount: null,
  hasAnyLiked: false,
} as const;

/** Membership for something not yet resolved against the library. */
const UNRESOLVED_MEMBERSHIP = { inLibrary: false } as const;

function toTrack(track: SpotifyTrack): Track {
  return {
    ...UNRESOLVED_MEMBERSHIP,
    id: track.id,
    name: track.name,
    artistNames: (track.artists ?? []).map((artist) => artist.name),
    albumName: track.album?.name ?? null,
    durationMs: track.duration_ms,
    uri: track.uri,
  };
}

function toArtist(artist: SpotifyArtist): Artist {
  return {
    ...UNRESOLVED_MEMBERSHIP,
    ...UNCOUNTED_COVERAGE,
    id: artist.id,
    name: artist.name,
    genres: artist.genres ?? [],
    uri: artist.uri,
    albumsWithLikedTracks: 0,
    totalAlbumCount: null,
  };
}

function toAlbum(album: SpotifyAlbum): Album {
  return {
    ...UNRESOLVED_MEMBERSHIP,
    ...UNCOUNTED_COVERAGE,
    id: album.id,
    name: album.name,
    artistNames: (album.artists ?? []).map((artist) => artist.name),
    releaseDate: album.release_date ?? null,
    uri: album.uri,
    // Unlike an artist's, an album's total is on the album object itself, so
    // it costs nothing and never needs the resolver.
    totalTrackCount: album.total_tracks ?? null,
  };
}

/**
 * Map one Spotify playlist onto the shared shape.
 *
 * Both nested objects are read defensively. Spotify's documentation says
 * `tracks` is always present and it is not — see `SpotifyPlaylist` — and
 * `owner` is the same class of nested object from the same endpoint, so it
 * gets the same treatment rather than waiting to be the next thing that
 * throws in production.
 */
function toPlaylist(playlist: SpotifyPlaylist): Playlist {
  return {
    ...UNRESOLVED_MEMBERSHIP,
    id: playlist.id,
    name: playlist.name,
    ownerName: playlist.owner?.display_name ?? playlist.owner?.id ?? UNKNOWN_OWNER_NAME,
    trackCount: playlist.tracks?.total ?? null,
    uri: playlist.uri,
  };
}

/** Shown when Spotify sends a playlist with no owner object at all. */
const UNKNOWN_OWNER_NAME = "unknown";

/** Offset-paginated Spotify endpoints all share this cursor shape: the next offset, as a string. */
function offsetPage<SpotifyItem, Item>(
  paging: SpotifyPagingObject<SpotifyItem>,
  map: (item: SpotifyItem) => Item,
): Page<Item> {
  return {
    items: paging.items.map(map),
    nextCursor: paging.next === null ? null : String(paging.offset + paging.items.length),
    total: paging.total,
  };
}

/**
 * Mark everything on a page as being in the library.
 *
 * The library endpoints only ever return saved or followed things, so
 * membership holds by construction and needs no call to confirm it. Applied
 * at the page level rather than threaded through every mapper, because the
 * fact belongs to *where the items came from*, not to the items themselves —
 * the same artist object is `inLibrary: false` when it arrives from a search.
 */
function markAsInLibrary<Item extends { inLibrary: boolean }>(page: Page<Item>): Page<Item> {
  return { ...page, items: page.items.map((item) => ({ ...item, inLibrary: true })) };
}

const emptyPage = <Item>(): Page<Item> => ({ items: [], nextCursor: null, total: 0 });

export class SpotifyProvider implements MediaProvider {
  readonly name = "spotify";
  private readonly client: SpotifyApiClient;

  constructor(accessToken: string) {
    this.client = new SpotifyApiClient(accessToken);
  }

  async search(
    query: string,
    options: { types?: SearchType[]; limit?: number; cursor?: string } = {},
  ): Promise<{
    tracks: Page<Track>;
    artists: Page<Artist>;
    albums: Page<Album>;
    playlists: Page<Playlist>;
  }> {
    const types = options.types ?? (["track", "artist", "album", "playlist"] as const);
    const limit = Math.min(options.limit ?? SEARCH_MAX_LIMIT, SEARCH_MAX_LIMIT);
    const offset = options.cursor ? Number(options.cursor) : 0;

    const result = await this.client.search(query, [...types], { limit, offset });

    // One contains-call per type rather than one per page overall: the four
    // pages are separate objects, and merging them to save three requests
    // would mean re-splitting the answers by position afterwards.
    const [tracks, artists, albums, playlists] = await Promise.all([
      this.resolveMembership(result.tracks ? offsetPage(result.tracks, toTrack) : emptyPage<Track>()),
      this.resolveMembership(result.artists ? offsetPage(result.artists, toArtist) : emptyPage<Artist>()),
      this.resolveMembership(result.albums ? offsetPage(result.albums, toAlbum) : emptyPage<Album>()),
      this.resolveMembership(
        result.playlists ? offsetPage(result.playlists, toPlaylist) : emptyPage<Playlist>(),
      ),
    ]);
    return { tracks, artists, albums, playlists };
  }

  async getLikedTracks(options: { limit?: number; cursor?: string } = {}): Promise<Page<Track>> {
    const paging = await this.client.getSavedTracks({
      limit: Math.min(options.limit ?? LIBRARY_MAX_LIMIT, LIBRARY_MAX_LIMIT),
      offset: options.cursor ? Number(options.cursor) : 0,
    });
    return markAsInLibrary(offsetPage(paging, (saved) => toTrack(saved.track)));
  }

  async getSavedAlbums(options: { limit?: number; cursor?: string } = {}): Promise<Page<Album>> {
    const paging = await this.client.getSavedAlbums({
      limit: Math.min(options.limit ?? LIBRARY_MAX_LIMIT, LIBRARY_MAX_LIMIT),
      offset: options.cursor ? Number(options.cursor) : 0,
    });
    return markAsInLibrary(offsetPage(paging, (saved) => toAlbum(saved.album)));
  }

  async getFollowedArtists(
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<Artist>> {
    const result = await this.client.getFollowedArtists({
      limit: Math.min(options.limit ?? LIBRARY_MAX_LIMIT, LIBRARY_MAX_LIMIT),
      after: options.cursor,
    });
    return markAsInLibrary({
      items: result.artists.items.map(toArtist),
      nextCursor: result.artists.cursors.after,
      total: result.artists.total,
    });
  }

  async getPlaylists(options: { limit?: number; cursor?: string } = {}): Promise<Page<Playlist>> {
    const paging = await this.client.getPlaylists({
      limit: Math.min(options.limit ?? LIBRARY_MAX_LIMIT, LIBRARY_MAX_LIMIT),
      offset: options.cursor ? Number(options.cursor) : 0,
    });
    return markAsInLibrary(offsetPage(paging, toPlaylist));
  }

  async getPlaylistTracks(
    playlistId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<Track>> {
    const paging = await this.client.getPlaylistTracks(playlistId, {
      limit: Math.min(options.limit ?? LIBRARY_MAX_LIMIT, LIBRARY_MAX_LIMIT),
      offset: options.cursor ? Number(options.cursor) : 0,
    });
    return offsetPage(paging, (entry) => toTrack(entry.item));
  }

  // --- Writes -------------------------------------------------------------

  async addTracksToPlaylist(
    playlistId: string,
    uris: string[],
    options: { position?: number } = {},
  ): Promise<void> {
    await this.client.addPlaylistItems(playlistId, uris, options);
  }

  async removeTracksFromPlaylist(playlistId: string, uris: string[]): Promise<void> {
    await this.client.removePlaylistItems(playlistId, uris);
  }

  async createPlaylist(details: {
    name: string;
    description?: string;
    isPublic?: boolean;
  }): Promise<Playlist> {
    const profile = await this.client.getCurrentUser();
    const created = await this.client.createPlaylist(profile.id, {
      name: details.name,
      description: details.description,
      public: details.isPublic,
    });
    if (created === null) {
      throw new Error("Spotify accepted the playlist creation but returned no playlist.");
    }
    return toPlaylist(created);
  }

  async updatePlaylistDetails(
    playlistId: string,
    details: { name?: string; description?: string; isPublic?: boolean },
  ): Promise<void> {
    await this.client.updatePlaylistDetails(playlistId, {
      name: details.name,
      description: details.description,
      public: details.isPublic,
    });
  }

  async saveToLibrary(uris: string[]): Promise<void> {
    await this.client.saveToLibrary(uris);
  }

  async removeFromLibrary(uris: string[]): Promise<void> {
    await this.client.removeFromLibrary(uris);
  }

  /**
   * Fill in `inLibrary` for a page of results, in one request.
   *
   * Search returns a mix of things the user has and things they do not, and
   * `/me/library/contains` answers every type at once — so the flag costs one
   * request per page rather than one per item or one per type.
   *
   * A failure here returns the page unchanged rather than propagating: an
   * unknown membership flag is a missing nicety, and failing the whole search
   * over it would be worse than the flag being false.
   */
  private async resolveMembership<Item extends { uri: string; inLibrary: boolean }>(
    page: Page<Item>,
  ): Promise<Page<Item>> {
    if (page.items.length === 0) {
      return page;
    }
    try {
      const contained = await this.client.checkLibraryContains(page.items.map((item) => item.uri));
      return {
        ...page,
        items: page.items.map((item, index) => ({ ...item, inLibrary: contained[index] ?? false })),
      };
    } catch {
      return page;
    }
  }

  async getQueue(): Promise<{ nowPlaying: Track | null; queue: Track[] }> {
    const state = await this.client.getQueue();
    return {
      nowPlaying: state.currently_playing === null ? null : toTrack(state.currently_playing),
      queue: (state.queue ?? []).map(toTrack),
    };
  }

  async addToQueue(uri: string, options: { deviceId?: string } = {}): Promise<void> {
    await this.client.addToQueue(uri, options);
  }

  // --- Playback -----------------------------------------------------------

  async getCurrentlyPlaying(): Promise<NowPlaying | null> {
    const state = await this.client.getCurrentlyPlaying();
    if (state === null) {
      return null;
    }
    return {
      isPlaying: state.is_playing,
      track: state.item === null ? null : toTrack(state.item),
      progressMs: state.progress_ms,
      deviceName: state.device?.name ?? null,
    };
  }

  async listDevices(): Promise<Device[]> {
    const { devices } = await this.client.getDevices();
    return devices.map((device) => ({
      id: device.id,
      name: device.name,
      type: device.type,
      isActive: device.is_active,
      isRestricted: device.is_restricted,
      volumePercent: device.volume_percent,
    }));
  }

  /**
   * Find a device by name, loosely.
   *
   * A caller saying "play on my phone" should not have to know that the
   * device is called `Idin's iPhone`. Matching is case-insensitive and
   * substring-based, and device *type* is matched too — "phone" finds a
   * `Smartphone`, "tv" finds a `TV` — because the type is usually what a
   * person means when they name a device casually.
   *
   * @param wanted - What the caller called it.
   * @returns The matching device, or null when nothing matches.
   */
  private async findDeviceByName(wanted: string): Promise<Device | null> {
    const devices = await this.listDevices();
    const needle = wanted.trim().toLowerCase();
    const matches = (device: Device): boolean =>
      device.name.toLowerCase().includes(needle)
      || device.type.toLowerCase().includes(needle)
      // "phone" should find a Smartphone, which the substring above misses
      // in the other direction.
      || needle.includes(device.type.toLowerCase());
    return devices.find(matches) ?? null;
  }

  /**
   * Start or resume playback, waking a device when none is active.
   *
   * Spotify fails a device-less `play` with `404 NO_ACTIVE_DEVICE` whenever
   * nothing is currently active — even when devices exist and are listed,
   * which is the normal state once nobody has played anything for a while.
   * Observed live on 2026-09-13: five devices listed, `play` refused, and the
   * same call with an explicit `device_id` worked and made that device
   * active.
   *
   * Failing there would be faithful to Spotify and useless to the caller,
   * who must then list devices, choose one, and retry — to reach a state it
   * never asked to care about. So that one error is retried once against a
   * device chosen here.
   *
   * Restricted devices are skipped: Spotify marks those as unable to accept
   * Web API commands, so targeting one trades this error for another.
   */
  async play(
    options: { uri?: string; deviceId?: string; deviceName?: string } = {},
  ): Promise<void> {
    const target = buildPlayTarget(options.uri);

    // A named device that is not there must be reported, never quietly
    // swapped for another. Asking for a phone and hearing the desktop speakers
    // with no explanation is worse than an error: the request was understood,
    // ignored, and not mentioned.
    if (options.deviceName !== undefined && options.deviceId === undefined) {
      const named = await this.findDeviceByName(options.deviceName);
      if (named === null) {
        const available = (await this.listDevices())
          .map((device) => `${device.name} (${device.type})`)
          .join(", ");
        throw new Error(
          `No Spotify device matching "${options.deviceName}" is available. `
            + `Spotify only lists a device while its app is running or was `
            + `recently open — for a phone, open Spotify on it and try again. `
            + `Currently available: ${available || "none"}.`,
        );
      }
      await this.client.play({ ...target, deviceId: named.id ?? undefined });
      return;
    }

    try {
      await this.client.play({ ...target, deviceId: options.deviceId });
      return;
    } catch (error) {
      // An explicit device was asked for, or the failure was something else:
      // either way this is not ours to recover from.
      if (options.deviceId !== undefined || !isNoActiveDevice(error)) {
        throw error;
      }
    }

    const { devices } = await this.client.getDevices();
    const usable = devices.find((device) => device.id !== null && !device.is_restricted);
    if (usable === undefined) {
      throw new Error(
        "No Spotify device is active, and none that can be woken was found. "
          + "Open Spotify on a phone, computer or speaker and try again — a "
          + "device only appears here once its app has run recently.",
      );
    }

    await this.client.play({ ...target, deviceId: usable.id ?? undefined });
  }

  async pause(options: { deviceId?: string } = {}): Promise<void> {
    await this.client.pause(options);
  }

  async skipToNext(options: { deviceId?: string } = {}): Promise<void> {
    await this.client.skipToNext(options);
  }

  async skipToPrevious(options: { deviceId?: string } = {}): Promise<void> {
    await this.client.skipToPrevious(options);
  }

  async transferPlayback(deviceId: string, options: { play?: boolean } = {}): Promise<void> {
    await this.client.transferPlayback(deviceId, options);
  }
}

/**
 * Decide how a URI is sent to Spotify's play endpoint.
 *
 * A single track goes in `uris`; an album, artist or playlist goes in
 * `context_uri`. Sending the wrong one fails, and it is the standard mistake
 * with this endpoint, so the decision is made here from the URI itself rather
 * than exposed as a parameter the caller has to get right.
 *
 * @param uri - A Spotify URI, or undefined to resume whatever is loaded.
 * @returns The field the play endpoint expects for this URI type.
 */
function buildPlayTarget(uri: string | undefined): { contextUri?: string; uris?: string[] } {
  if (uri === undefined) {
    return {};
  }
  return uri.startsWith(TRACK_URI_PREFIX) ? { uris: [uri] } : { contextUri: uri };
}

/** Spotify URI prefix for a single track — the one type that plays via `uris`. */
const TRACK_URI_PREFIX = "spotify:track:";
