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
  type SpotifyAlbum,
  type SpotifyArtist,
  type SpotifyPagingObject,
  type SpotifyPlaylist,
  type SpotifyTrack,
} from "./spotify_api_client";
import type {
  Album,
  Artist,
  MediaProvider,
  Page,
  Playlist,
  SearchType,
  Track,
} from "../media_provider";

function toTrack(track: SpotifyTrack): Track {
  return {
    id: track.id,
    name: track.name,
    artistNames: track.artists.map((artist) => artist.name),
    albumName: track.album.name,
    durationMs: track.duration_ms,
    uri: track.uri,
  };
}

function toArtist(artist: SpotifyArtist): Artist {
  return { id: artist.id, name: artist.name, genres: artist.genres, uri: artist.uri };
}

function toAlbum(album: SpotifyAlbum): Album {
  return {
    id: album.id,
    name: album.name,
    artistNames: album.artists.map((artist) => artist.name),
    releaseDate: album.release_date,
    uri: album.uri,
  };
}

function toPlaylist(playlist: SpotifyPlaylist): Playlist {
  return {
    id: playlist.id,
    name: playlist.name,
    ownerName: playlist.owner.display_name ?? playlist.owner.id,
    trackCount: playlist.tracks.total,
    uri: playlist.uri,
  };
}

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

    return {
      tracks: result.tracks ? offsetPage(result.tracks, toTrack) : emptyPage(),
      artists: result.artists ? offsetPage(result.artists, toArtist) : emptyPage(),
      albums: result.albums ? offsetPage(result.albums, toAlbum) : emptyPage(),
      playlists: result.playlists ? offsetPage(result.playlists, toPlaylist) : emptyPage(),
    };
  }

  async getLikedTracks(options: { limit?: number; cursor?: string } = {}): Promise<Page<Track>> {
    const paging = await this.client.getSavedTracks({
      limit: Math.min(options.limit ?? LIBRARY_MAX_LIMIT, LIBRARY_MAX_LIMIT),
      offset: options.cursor ? Number(options.cursor) : 0,
    });
    return offsetPage(paging, (saved) => toTrack(saved.track));
  }

  async getSavedAlbums(options: { limit?: number; cursor?: string } = {}): Promise<Page<Album>> {
    const paging = await this.client.getSavedAlbums({
      limit: Math.min(options.limit ?? LIBRARY_MAX_LIMIT, LIBRARY_MAX_LIMIT),
      offset: options.cursor ? Number(options.cursor) : 0,
    });
    return offsetPage(paging, (saved) => toAlbum(saved.album));
  }

  async getFollowedArtists(
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<Artist>> {
    const result = await this.client.getFollowedArtists({
      limit: Math.min(options.limit ?? LIBRARY_MAX_LIMIT, LIBRARY_MAX_LIMIT),
      after: options.cursor,
    });
    return {
      items: result.artists.items.map(toArtist),
      nextCursor: result.artists.cursors.after,
      total: result.artists.total,
    };
  }

  async getPlaylists(options: { limit?: number; cursor?: string } = {}): Promise<Page<Playlist>> {
    const paging = await this.client.getPlaylists({
      limit: Math.min(options.limit ?? LIBRARY_MAX_LIMIT, LIBRARY_MAX_LIMIT),
      offset: options.cursor ? Number(options.cursor) : 0,
    });
    return offsetPage(paging, toPlaylist);
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
}
