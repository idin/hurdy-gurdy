/**
 * Reading and writing the cache's D1 tables.
 *
 * Every statement lives here rather than in the decorator above it, so that
 * "what SQL runs" and "when it runs" stay separable — the decorator can be
 * read for its caching policy without SQL in the way, and this file can be
 * tested against a real database without a provider.
 *
 * Coverage metrics are **read from views**, never computed here. A count
 * assembled in TypeScript is a second implementation of the view, and the two
 * would eventually disagree.
 */

import {
  expiryFrom,
  lookUpCacheEntry,
  type CacheEntry,
  type CacheLookup,
} from "./cache_entry";
import { MEDIA_CACHE_SCHEMA } from "./media_cache_schema";

/**
 * Whether the schema has been applied to this database already.
 *
 * Memoised per isolate, not per call. `other-memory` learned this the
 * expensive way: running the CREATE batch on every operation cost around
 * twelve subrequests per round against a fifty-subrequest budget, which is a
 * quarter of the budget spent on statements that do nothing after the first
 * time.
 */
const preparedDatabases = new WeakSet<D1Database>();

/**
 * Create tables and views if they are absent.
 *
 * Idempotent by construction — every statement is `IF NOT EXISTS` — so this
 * is safe to call on a cold start without knowing whether anyone else has.
 *
 * @param database - The bound D1 database.
 */
export async function prepareMediaCache(database: D1Database): Promise<void> {
  if (preparedDatabases.has(database)) {
    return;
  }
  await database.batch(MEDIA_CACHE_SCHEMA.map((statement) => database.prepare(statement)));
  preparedDatabases.add(database);
}

/**
 * Look up a cached provider response, renewing its expiry if it is fresh.
 *
 * The renewal is written back here rather than left to the caller: an entry
 * that is read but never renewed expires while in active use, which is the
 * precise failure the sliding rule exists to prevent and one that would only
 * surface as unexplained re-fetching weeks later.
 *
 * @param database - The bound D1 database.
 * @param key - From `buildCacheKey`.
 * @param now - Epoch milliseconds.
 * @returns What was found, and in what state.
 */
export async function findCachedResponse(
  database: D1Database,
  key: string,
  now: number,
): Promise<CacheLookup> {
  const row = await database
    .prepare(
      `SELECT key, payload, etag, total, expires_at AS expiresAt
         FROM cached_response WHERE key = ?`,
    )
    .bind(key)
    .first<CacheEntry>();

  const lookup = lookUpCacheEntry(row ?? null, now);

  if (lookup.state === "fresh") {
    await database
      .prepare(`UPDATE cached_response SET expires_at = ? WHERE key = ?`)
      .bind(lookup.entry.expiresAt, key)
      .run();
  }

  return lookup;
}

/**
 * Store a provider response, replacing any existing entry for the same key.
 *
 * @param database - The bound D1 database.
 * @param entry - What to store, minus the expiry, which is derived here so a
 *   caller cannot accidentally store one that never expires.
 * @param now - Epoch milliseconds.
 */
export async function storeCachedResponse(
  database: D1Database,
  entry: { key: string; payload: string; etag: string | null; total: number | null },
  now: number,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO cached_response (key, payload, etag, total, expires_at)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         payload = excluded.payload,
         etag = excluded.etag,
         total = excluded.total,
         expires_at = excluded.expires_at`,
    )
    .bind(entry.key, entry.payload, entry.etag, entry.total, expiryFrom(now))
    .run();
}

/**
 * Renew a stale entry that revalidation proved is still correct.
 *
 * Separate from `storeCachedResponse` because a `304 Not Modified` carries no
 * body: there is nothing to write but the new expiry, and passing the old
 * payload back through a full upsert would be pointless work and an easy
 * place to write the wrong thing.
 *
 * @param database - The bound D1 database.
 * @param key - The entry to renew.
 * @param now - Epoch milliseconds.
 */
export async function renewCachedResponse(
  database: D1Database,
  key: string,
  now: number,
): Promise<void> {
  await database
    .prepare(`UPDATE cached_response SET expires_at = ? WHERE key = ?`)
    .bind(expiryFrom(now), key)
    .run();
}

/**
 * Delete entries whose expiry has passed.
 *
 * This is what makes "do not store Spotify content indefinitely" literally
 * true rather than merely claimed: an entry nobody has read in 66 days is
 * removed, not just ignored.
 *
 * @param database - The bound D1 database.
 * @param now - Epoch milliseconds.
 * @returns How many rows were removed.
 */
export async function sweepExpiredResponses(
  database: D1Database,
  now: number,
): Promise<number> {
  const result = await database
    .prepare(`DELETE FROM cached_response WHERE expires_at <= ?`)
    .bind(now)
    .run();
  return result.meta.changes ?? 0;
}

/** Coverage for one album, as the `album_coverage` view reports it. */
export type AlbumCoverage = {
  likedTrackCount: number;
  totalTrackCount: number | null;
  hasAnyLiked: boolean;
};

/** Coverage for one artist, as the `artist_coverage` view reports it. */
export type ArtistCoverage = AlbumCoverage & {
  albumsWithLikedTracks: number;
  totalAlbumCount: number | null;
};

/**
 * Read album coverage for several albums at once.
 *
 * Batched by URI rather than fetched per item, because a page of search
 * results wants coverage for every album on it and one query per album would
 * spend the Worker's subrequest budget on a single page.
 *
 * @param database - The bound D1 database.
 * @param albumUris - Albums to look up.
 * @returns Coverage by URI. An album absent from the cache is absent here —
 *   callers distinguish "no liked tracks" from "never seen" by that.
 */
export async function findAlbumCoverage(
  database: D1Database,
  albumUris: string[],
): Promise<Map<string, AlbumCoverage>> {
  if (albumUris.length === 0) {
    return new Map();
  }
  const placeholders = albumUris.map(() => "?").join(",");
  const { results } = await database
    .prepare(
      `SELECT album_uri, liked_track_count, total_track_count, has_any_liked
         FROM album_coverage WHERE album_uri IN (${placeholders})`,
    )
    .bind(...albumUris)
    .all<{
      album_uri: string;
      liked_track_count: number;
      total_track_count: number | null;
      has_any_liked: number;
    }>();

  return new Map(
    (results ?? []).map((row) => [
      row.album_uri,
      {
        likedTrackCount: row.liked_track_count,
        totalTrackCount: row.total_track_count,
        hasAnyLiked: row.has_any_liked === 1,
      },
    ]),
  );
}

/**
 * Read artist coverage for several artists at once.
 *
 * @param database - The bound D1 database.
 * @param artistUris - Artists to look up.
 * @returns Coverage by URI, for those the cache knows about.
 */
export async function findArtistCoverage(
  database: D1Database,
  artistUris: string[],
): Promise<Map<string, ArtistCoverage>> {
  if (artistUris.length === 0) {
    return new Map();
  }
  const placeholders = artistUris.map(() => "?").join(",");
  const { results } = await database
    .prepare(
      `SELECT artist_uri, liked_track_count, total_track_count,
              albums_with_liked_tracks, total_album_count, has_any_liked
         FROM artist_coverage WHERE artist_uri IN (${placeholders})`,
    )
    .bind(...artistUris)
    .all<{
      artist_uri: string;
      liked_track_count: number;
      total_track_count: number | null;
      albums_with_liked_tracks: number;
      total_album_count: number | null;
      has_any_liked: number;
    }>();

  return new Map(
    (results ?? []).map((row) => [
      row.artist_uri,
      {
        likedTrackCount: row.liked_track_count,
        totalTrackCount: row.total_track_count,
        albumsWithLikedTracks: row.albums_with_liked_tracks,
        totalAlbumCount: row.total_album_count,
        hasAnyLiked: row.has_any_liked === 1,
      },
    ]),
  );
}

/**
 * Which playlists hold each of these tracks.
 *
 * Answers the state Spotify has no endpoint for: a track present in several
 * playlists but never liked, which is neither "in the library" nor "unknown
 * to me".
 *
 * @param database - The bound D1 database.
 * @param trackUris - Tracks to look up.
 * @returns Playlist URIs by track URI, for tracks in at least one playlist.
 */
export async function findPlaylistMembership(
  database: D1Database,
  trackUris: string[],
): Promise<Map<string, string[]>> {
  if (trackUris.length === 0) {
    return new Map();
  }
  const placeholders = trackUris.map(() => "?").join(",");
  const { results } = await database
    .prepare(
      `SELECT track_uri, playlist_uris
         FROM track_playlist_membership WHERE track_uri IN (${placeholders})`,
    )
    .bind(...trackUris)
    .all<{ track_uri: string; playlist_uris: string }>();

  return new Map(
    (results ?? []).map((row) => [row.track_uri, row.playlist_uris.split(",")]),
  );
}
