/**
 * The cache's tables, and the views that derive every metric from them.
 *
 * The split is the whole design. **Tables hold facts**: which tracks are
 * liked, which tracks are in which playlist, what an album's track count is.
 * **Views hold everything derived**: how many liked tracks an artist has, how
 * many of an album's tracks are liked, whether anything by an artist is
 * liked at all.
 *
 * Nothing derived is ever stored. A stored `liked_track_count` is wrong the
 * moment a track is liked, and correcting it means invalidation logic that
 * has to be right everywhere it fires. A view cannot drift, because there is
 * nothing to drift from — it is recomputed from the rows each time it is
 * read, and SQLite is fast enough at this scale that the cost is not worth
 * discussing.
 *
 * Schema creation is idempotent: every statement is `IF NOT EXISTS`, so
 * running it on every cold start is safe and no migration runner is needed
 * for the initial shape.
 */

/**
 * Every statement needed to bring an empty database up to the current shape.
 *
 * Ordered so a table exists before any view reads it.
 */
export const MEDIA_CACHE_SCHEMA: readonly string[] = [
  // --- Raw provider responses ---------------------------------------------
  //
  // The sliding-expiry cache from `cache_entry.ts`, stored rather than
  // derived because a provider response is a fact about what was returned.
  `CREATE TABLE IF NOT EXISTS cached_response (
     key         TEXT PRIMARY KEY,
     payload     TEXT NOT NULL,
     etag        TEXT,
     total       INTEGER,
     expires_at  INTEGER NOT NULL
   )`,

  // Sweeping expired rows is a range scan over expires_at, so it gets an
  // index; without one the sweep degrades as the cache grows.
  `CREATE INDEX IF NOT EXISTS cached_response_expires_at
     ON cached_response (expires_at)`,

  // --- Facts ---------------------------------------------------------------

  /*
   * One row per track the provider has told us about, liked or not.
   *
   * `is_liked` rather than a separate liked_track table: a track's likedness
   * is an attribute of the track, and splitting it would mean a join to
   * answer the most common question asked of this table.
   */
  `CREATE TABLE IF NOT EXISTS track (
     uri          TEXT PRIMARY KEY,
     id           TEXT NOT NULL,
     name         TEXT NOT NULL,
     album_uri    TEXT,
     duration_ms  INTEGER,
     is_liked     INTEGER NOT NULL DEFAULT 0,
     -- When the like happened, as the provider reported it. Null for tracks
     -- seen in a playlist or a search rather than in the liked library.
     liked_at     TEXT,
     cached_at    INTEGER NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS track_album ON track (album_uri)`,
  `CREATE INDEX IF NOT EXISTS track_is_liked ON track (is_liked)`,

  /*
   * Track-to-artist, as its own table.
   *
   * A track has many artists — collaborations, features, compilations — and
   * Idin's schema requirement from 2026-09-11 was explicit that one artist
   * per track must not be assumed. A join table is the only shape that does
   * not lose the second name.
   */
  `CREATE TABLE IF NOT EXISTS track_artist (
     track_uri   TEXT NOT NULL,
     artist_uri  TEXT NOT NULL,
     PRIMARY KEY (track_uri, artist_uri)
   )`,

  `CREATE INDEX IF NOT EXISTS track_artist_by_artist ON track_artist (artist_uri)`,

  `CREATE TABLE IF NOT EXISTS album (
     uri           TEXT PRIMARY KEY,
     id            TEXT NOT NULL,
     name          TEXT NOT NULL,
     release_date  TEXT,
     -- Spotify carries this on the album object, so it is a fact we are told
     -- rather than one we count. Null when the provider withheld it.
     total_tracks  INTEGER,
     is_saved      INTEGER NOT NULL DEFAULT 0,
     cached_at     INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS album_artist (
     album_uri   TEXT NOT NULL,
     artist_uri  TEXT NOT NULL,
     PRIMARY KEY (album_uri, artist_uri)
   )`,

  `CREATE TABLE IF NOT EXISTS artist (
     uri              TEXT PRIMARY KEY,
     id               TEXT NOT NULL,
     name             TEXT NOT NULL,
     genres           TEXT,
     is_followed      INTEGER NOT NULL DEFAULT 0,
     -- Null until the resolver has crawled this artist's discography.
     -- Spotify publishes no total-tracks figure, so it must be counted.
     total_track_count INTEGER,
     total_album_count INTEGER,
     cached_at        INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS playlist (
     uri          TEXT PRIMARY KEY,
     id           TEXT NOT NULL,
     name         TEXT NOT NULL,
     owner_name   TEXT,
     track_count  INTEGER,
     is_followed  INTEGER NOT NULL DEFAULT 0,
     cached_at    INTEGER NOT NULL
   )`,

  /*
   * Which tracks are in which playlist.
   *
   * This is what answers "I have this in three playlists but never liked
   * it" — a state Spotify offers no endpoint for, and the reason a track can
   * be present to the user while `inLibrary` is correctly false.
   */
  `CREATE TABLE IF NOT EXISTS playlist_track (
     playlist_uri  TEXT NOT NULL,
     track_uri     TEXT NOT NULL,
     position      INTEGER,
     PRIMARY KEY (playlist_uri, track_uri)
   )`,

  `CREATE INDEX IF NOT EXISTS playlist_track_by_track ON playlist_track (track_uri)`,

  // --- Derived ------------------------------------------------------------
  //
  // Never stored. Each is computed from the tables above on read, so no
  // value here can disagree with the facts it comes from.

  /*
   * Album coverage: how much of each album the library holds.
   *
   * `total_tracks` comes from the album row rather than counting `track`,
   * because the cache may hold only the liked tracks from an album — counting
   * rows would make every partially-cached album look complete.
   */
  `CREATE VIEW IF NOT EXISTS album_coverage AS
     SELECT
       album.uri                                   AS album_uri,
       COUNT(CASE WHEN track.is_liked = 1 THEN 1 END) AS liked_track_count,
       album.total_tracks                          AS total_track_count,
       CASE WHEN COUNT(CASE WHEN track.is_liked = 1 THEN 1 END) > 0
            THEN 1 ELSE 0 END                      AS has_any_liked
     FROM album
     LEFT JOIN track ON track.album_uri = album.uri
     GROUP BY album.uri, album.total_tracks`,

  /*
   * Artist coverage: liked tracks, and how many distinct albums they span.
   *
   * The album count is the second axis Idin asked for: forty liked tracks
   * from one album is a different relationship to an artist than one track
   * from each of forty albums, and a track count alone cannot tell them
   * apart.
   */
  `CREATE VIEW IF NOT EXISTS artist_coverage AS
     SELECT
       artist.uri                                     AS artist_uri,
       COUNT(DISTINCT CASE WHEN track.is_liked = 1
                           THEN track.uri END)        AS liked_track_count,
       artist.total_track_count                       AS total_track_count,
       COUNT(DISTINCT CASE WHEN track.is_liked = 1
                           THEN track.album_uri END)  AS albums_with_liked_tracks,
       artist.total_album_count                       AS total_album_count,
       CASE WHEN COUNT(CASE WHEN track.is_liked = 1 THEN 1 END) > 0
            THEN 1 ELSE 0 END                         AS has_any_liked
     FROM artist
     LEFT JOIN track_artist ON track_artist.artist_uri = artist.uri
     LEFT JOIN track        ON track.uri = track_artist.track_uri
     GROUP BY artist.uri, artist.total_track_count, artist.total_album_count`,

  /*
   * Which playlists hold each track, as a comma-joined list of URIs.
   *
   * A caller asking "where do I already have this?" gets one row rather than
   * a second query per track.
   */
  `CREATE VIEW IF NOT EXISTS track_playlist_membership AS
     SELECT
       playlist_track.track_uri                        AS track_uri,
       COUNT(*)                                        AS playlist_count,
       GROUP_CONCAT(playlist_track.playlist_uri)       AS playlist_uris
     FROM playlist_track
     GROUP BY playlist_track.track_uri`,
];
