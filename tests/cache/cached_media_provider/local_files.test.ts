import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CachedMediaProvider } from "../../../src/cache/cached_media_provider";
import { prepareMediaCache } from "../../../src/cache/media_cache_store";
import { SpotifyProvider } from "../../../src/providers/spotify/spotify_provider";

/**
 * A playlist can hold the user's own local files, and Spotify describes those
 * with nulls where a catalogue track has identities.
 *
 * The first local track below is copied verbatim from Spotify's Playlists
 * concept page (developer.spotify.com/documentation/web-api/concepts/playlists,
 * read 2026-09-30): `id: null` on the track, its album and its artist,
 * `uri: null` on the album and artist, `external_ids: {}`, and a
 * `spotify:local:` track URI. The second follows the same documented format
 * for a different artist and album, because the merging bug needs two.
 *
 * Run end to end — Spotify's JSON, through the real mapper and the real cache
 * layer, into a real D1 — with only `fetch` faked, as the provider tests do.
 */

const database = (env as { MEDIA_CACHE: D1Database }).MEDIA_CACHE;
const NOW = Date.parse("2026-09-30T12:00:00Z");
const PLAYLIST_ID = "37i9dQZF1DX4UtSsGT1Sbe";

const DOCUMENTED_LOCAL_TRACK = {
  album: {
    album_type: null,
    available_markets: [],
    external_urls: {},
    href: null,
    id: null,
    images: [],
    name: "Donkey Kong Country: Tropical Freeze",
    type: "album",
    uri: null,
  },
  artists: [
    {
      external_urls: {},
      href: null,
      id: null,
      name: "David Wise",
      type: "artist",
      uri: null,
    },
  ],
  available_markets: [],
  disc_number: 0,
  duration_ms: 127000,
  explicit: false,
  external_ids: {},
  external_urls: {},
  href: null,
  id: null,
  name: "Snomads Island",
  popularity: 0,
  preview_url: null,
  track_number: 0,
  type: "track",
  uri: "spotify:local:David+Wise:Donkey+Kong+Country%3A+Tropical+Freeze:Snomads+Island:127",
};

const SECOND_LOCAL_TRACK = {
  ...DOCUMENTED_LOCAL_TRACK,
  album: { ...DOCUMENTED_LOCAL_TRACK.album, name: "Chrono Trigger" },
  artists: [{ ...DOCUMENTED_LOCAL_TRACK.artists[0], name: "Yasunori Mitsuda" }],
  duration_ms: 212000,
  name: "Corridors of Time",
  uri: "spotify:local:Yasunori+Mitsuda:Chrono+Trigger:Corridors+of+Time:212",
};

const CATALOGUE_TRACK = {
  id: "0vFOzaXqZHahrZp6enQwQb",
  name: "Money",
  artists: [{ id: "0k17h0D3J5VfsdmQ1iZtE9", name: "Pink Floyd" }],
  album: { id: "4LH4d3cOWNNsVw41Gqt2kv", name: "The Dark Side of the Moon", total_tracks: 10 },
  duration_ms: 382826,
  external_ids: { isrc: "GBN9Y1100088" },
  uri: "spotify:track:0vFOzaXqZHahrZp6enQwQb",
};

/** `GET /playlists/{id}/items`, holding one catalogue track and two local files. */
const PLAYLIST_ITEMS_RESPONSE = {
  href: `https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/items?offset=0&limit=50`,
  limit: 50,
  next: null,
  offset: 0,
  previous: null,
  total: 3,
  items: [
    { added_at: "2026-09-01T00:00:00Z", is_local: false, item: CATALOGUE_TRACK },
    { added_at: "2026-09-02T00:00:00Z", is_local: true, item: DOCUMENTED_LOCAL_TRACK },
    { added_at: "2026-09-03T00:00:00Z", is_local: true, item: SECOND_LOCAL_TRACK },
  ],
};

const originalFetch = globalThis.fetch;
let spotifyRequests = 0;

function buildCachedProvider(): CachedMediaProvider {
  return new CachedMediaProvider(new SpotifyProvider("test-token"), database, () => NOW);
}

beforeEach(async () => {
  await prepareMediaCache(database);
  for (const table of [
    "cached_response",
    "resolution_queue",
    "playlist_track",
    "track_artist",
    "track",
    "album",
    "artist",
  ]) {
    await database.prepare(`DELETE FROM ${table}`).run();
  }
  spotifyRequests = 0;
  globalThis.fetch = vi.fn(async () => {
    spotifyRequests += 1;
    return new Response(JSON.stringify(PLAYLIST_ITEMS_RESPONSE), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("a playlist holding local files", () => {
  test("is served from cache on the second read", async () => {
    const cached = buildCachedProvider();

    await cached.getPlaylistTracks(PLAYLIST_ID);
    await cached.getPlaylistTracks(PLAYLIST_ID);

    expect(spotifyRequests).toBe(1);
  });

  test("still records the catalogue track that shares its page", async () => {
    await buildCachedProvider().getPlaylistTracks(PLAYLIST_ID);

    const row = await database
      .prepare(`SELECT name FROM track WHERE uri = ?`)
      .bind(CATALOGUE_TRACK.uri)
      .first<{ name: string }>();
    expect(row).toEqual({ name: "Money" });
  });

  test("does not merge two local artists into one fake artist", async () => {
    await buildCachedProvider().getPlaylistTracks(PLAYLIST_ID);

    const { results } = await database
      .prepare(`SELECT uri, name FROM artist WHERE uri LIKE '%:null'`)
      .all<{ uri: string; name: string }>();
    expect(results).toEqual([]);
  });

  test("does not merge two local albums into one fake album", async () => {
    await buildCachedProvider().getPlaylistTracks(PLAYLIST_ID);

    const { results } = await database
      .prepare(`SELECT uri, name FROM album WHERE uri LIKE '%:null'`)
      .all<{ uri: string; name: string }>();
    expect(results).toEqual([]);
  });
});
