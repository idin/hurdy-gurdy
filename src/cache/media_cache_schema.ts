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
 * Schema creation is idempotent, but tables and views get there differently.
 *
 * **Tables** are `CREATE TABLE IF NOT EXISTS` — an existing one is left
 * alone, because it holds rows. Changing a table's shape is what
 * `apply_migrations.ts` is for.
 *
 * **Views** are `DROP VIEW IF EXISTS` immediately followed by `CREATE VIEW`,
 * as an adjacent pair. A view holds nothing, so rebuilding it costs nothing —
 * and it is the only schema object whose *definition* can change in place, so
 * `IF NOT EXISTS` would pin a live database to whatever definition it first
 * saw. The pair makes a changed view reach production on the next start.
 *
 * The drop belongs **here, beside its own create**, and never in the
 * migration list. Migrations run after this batch, so a `DROP VIEW` there
 * removes what this step just built — on every startup, not once. That
 * happened on 2026-09-18 and left every metric unqueryable in production
 * while all 321 tests passed. See
 * `docs/bugs/resolved/2026-09-18_a_drop_view_migration_destroys_the_view_on_every_startup.md`.
 */

import { DEFAULT_LENGTH_WEIGHT_EXPONENT } from "../metrics/duration_weighted_completion";

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
     -- REAL, because the completion ratios divide by it. Spotify reports
     -- milliseconds; the provider converts once on the way in.
     duration_seconds  REAL,
     is_liked     INTEGER NOT NULL DEFAULT 0,
     -- When the like happened, as the provider reported it. Null for tracks
     -- seen in a playlist or a search rather than in the liked library.
     liked_at     TEXT,
     -- Groups a track with the same song on another master. Includes the
     -- duration bucket, because Detroit Rock City exists as a long version
     -- opening with a radio and car engines and a short one that is just the
     -- music — two different tracks, and merging them would lose that.
     song_key     TEXT,
     -- The recording's ISRC. Identifies a recording ACROSS services, so it is
     -- the hop from a Spotify id to a MusicBrainz id and the spine the
     -- permanent catalogue will be keyed on. Arrives free on every /me/tracks
     -- page; the type simply never asked for it until 2026-09-13.
     isrc         TEXT,
     -- MusicBrainz identity, filled in by the resolver. recording_mbid names
     -- this exact performance; work_mbid names the COMPOSITION, which is what
     -- groups different artists' versions of one song — the level ISRC
     -- deliberately separates and Spotify does not model at all.
     --
     -- A null work_mbid means MusicBrainz has no recording-to-work link, not
     -- that no composition exists. That relation is among the least complete
     -- in a crowd-sourced database.
     recording_mbid TEXT,
     work_mbid    TEXT,
     work_title   TEXT,
     -- From the data export's streaming history, which the Web API cannot
     -- supply at any price. Plays past the 30s skip threshold and plays
     -- abandoned before it are counted separately: a track dropped after
     -- four seconds is evidence AGAINST liking it, and summing the two would
     -- make a heavily-skipped track look popular. Null until an import runs.
     play_count   INTEGER,
     skip_count   INTEGER,
     last_played  TEXT,
     cached_at    INTEGER NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS track_song_key ON track (song_key)`,
  `CREATE INDEX IF NOT EXISTS track_work_mbid ON track (work_mbid)`,

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
     -- Groups an album with its other masters. Computed on write from the
     -- normalised title, liveness and track count, so a remaster and its
     -- original share one. Every version keeps its own row; only the views
     -- merge them.
     work_key      TEXT,
     cached_at     INTEGER NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS album_work_key ON album (work_key)`,

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

  /*
   * A track the user has pinned as the best version of its song.
   *
   * The one thing here that is stated rather than derived: a pin is Idin's
   * preference, and nothing infers it. It overrides every heuristic — a newer
   * remaster does not displace a pinned track, and re-running the finder does
   * not clear it. This is the escape hatch that lets the matching rules stay
   * simple, because any case they get wrong can be settled by hand.
   */
  `CREATE TABLE IF NOT EXISTS pinned_track (
     track_uri  TEXT PRIMARY KEY,
     song_key   TEXT NOT NULL,
     pinned_at  INTEGER NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS pinned_track_song ON pinned_track (song_key)`,

  /*
   * One row per play, as the extended streaming history records it.
   *
   * **Replaces the earlier `song_plays`, which stored counts.** Counts are
   * derivable from plays and plays are not derivable from counts, so storing
   * the aggregate was storing the wrong thing — every metric built since
   * needs `ms_played` per play, and none of them could be computed from a
   * `play_count` column.
   *
   * Keyed on the URI rather than the track name, which the older account
   * export forced. The extended history carries `spotify_track_uri` on 58,327
   * of 58,521 plays, so the name-matching that once gave three copies of "Eye
   * In The Sky" 21 plays each is no longer needed.
   *
   * `played_at` completes the key. Two plays of one track at the same second
   * do not happen; the same track on different days must not collide.
   *
   * `skipped` is the one derived column stored here rather than computed in a
   * view, and deliberately so: it depends on thresholds clustered from the
   * whole library at import time, which a per-row view cannot see. It is
   * rewritten wholesale on each import, never patched.
   */
  `CREATE TABLE IF NOT EXISTS play (
     track_uri         TEXT NOT NULL,
     played_at         TEXT NOT NULL,
     -- REAL, not INTEGER: the completion ratios divide by a duration, and
     -- rounding a play to whole seconds would put error into every one of
     -- them. The export reports milliseconds; the conversion happens on write.
     seconds_played    REAL NOT NULL,
     reason_start      TEXT,
     reason_end        TEXT,
     shuffle           INTEGER,
     skipped           INTEGER NOT NULL DEFAULT 0,
     imported_at       INTEGER NOT NULL,
     PRIMARY KEY (track_uri, played_at)
   )`,

  `CREATE INDEX IF NOT EXISTS play_track_uri ON play (track_uri)`,
  `CREATE INDEX IF NOT EXISTS play_played_at ON play (played_at)`,

  /*
   * Per-user monthly budget on uncached work.
   *
   * Counts what leaves the building — a Spotify call, a resolver crawl — and
   * deliberately not cache reads. A user who reads the same artist a hundred
   * times costs one upstream fetch, and charging for a hundred would punish
   * exactly the behaviour the cache exists to encourage.
   *
   * Reasoning in `quota/fetch_budget.ts`.
   */
  `CREATE TABLE IF NOT EXISTS fetch_budget (
     user_id     TEXT NOT NULL,
     period      TEXT NOT NULL,
     spent       INTEGER NOT NULL DEFAULT 0,
     updated_at  INTEGER NOT NULL,
     PRIMARY KEY (user_id, period)
   )`,

  // --- Resolver work -------------------------------------------------------
  //
  // Declared here rather than in the resolver so there is exactly one place
  // that creates tables. Its shape and reasoning live in
  // `resolver/resolution_queue.ts`.
  `CREATE TABLE IF NOT EXISTS resolution_queue (
     kind         TEXT NOT NULL,
     subject_uri  TEXT NOT NULL,
     priority     INTEGER NOT NULL,
     cursor       TEXT,
     accumulated  INTEGER NOT NULL DEFAULT 0,
     attempts     INTEGER NOT NULL DEFAULT 0,
     enqueued_at  INTEGER NOT NULL,
     PRIMARY KEY (kind, subject_uri)
   )`,

  `CREATE INDEX IF NOT EXISTS resolution_queue_drain_order
     ON resolution_queue (priority, enqueued_at)`,

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
  `DROP VIEW IF EXISTS album_coverage`,
  `CREATE VIEW album_coverage AS
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
  `DROP VIEW IF EXISTS artist_coverage`,
  `CREATE VIEW artist_coverage AS
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
   * One row per album work, pooling every master of it.
   *
   * This is what stops a remaster counting twice. A like on the original and
   * a like on the 2018 remix are two likes of one album, not one like of each
   * of two — and the numerator is a DISTINCT count over `song_key`, so liking
   * the *same* song on both masters counts once.
   *
   * The canonical version is the most recent release, which is the newest
   * master and what Spotify itself surfaces first.
   */
  `DROP VIEW IF EXISTS album_work`,
  `CREATE VIEW album_work AS
     SELECT
       album.work_key                                       AS work_key,
       MIN(album.name)                                      AS name,
       MAX(album.release_date)                              AS latest_release_date,
       COUNT(DISTINCT album.uri)                            AS version_count,
       MAX(album.total_tracks)                              AS total_track_count,
       MAX(CASE WHEN album.is_saved = 1 THEN 1 ELSE 0 END)  AS is_saved
     FROM album
     WHERE album.work_key IS NOT NULL
     GROUP BY album.work_key`,

  /*
   * Coverage over a work rather than over one pressing.
   *
   * `COUNT(DISTINCT track.song_key)` is the union Idin asked for: every liked
   * song across every master, counted once each. Without DISTINCT, liking the
   * same song on two remasters would read as two liked tracks.
   */
  `DROP VIEW IF EXISTS work_coverage`,
  `CREATE VIEW work_coverage AS
     SELECT
       album.work_key                                        AS work_key,
       COUNT(DISTINCT CASE WHEN track.is_liked = 1
                           THEN COALESCE(track.song_key, track.uri) END)
                                                             AS liked_track_count,
       MAX(album.total_tracks)                               AS total_track_count,
       CASE WHEN COUNT(CASE WHEN track.is_liked = 1 THEN 1 END) > 0
            THEN 1 ELSE 0 END                                AS has_any_liked
     FROM album
     LEFT JOIN track ON track.album_uri = album.uri
     WHERE album.work_key IS NOT NULL
     GROUP BY album.work_key`,

  /*
   * Which works count toward an artist's metrics.
   *
   * Idin's ruling on live records: when a work exists as both live and
   * studio, the live one is ignored — it is mostly the same songs again, and
   * counting it inflates the artist's totals. When only a live version
   * exists, it counts.
   *
   * The work key carries liveness in its second field, so the studio twin of
   * a live work is the same key with `|live|` replaced by `|studio|`.
   */
  `DROP VIEW IF EXISTS countable_work`,
  `CREATE VIEW countable_work AS
     SELECT work_key
       FROM album_work AS this
      WHERE this.work_key NOT LIKE '%|live|%'
         OR NOT EXISTS (
              SELECT 1 FROM album_work AS twin
               WHERE twin.work_key =
                     REPLACE(this.work_key, '|live|', '|studio|')
            )`,

  /*
   * Every listening metric for a track, derived from its plays.
   *
   * A view rather than columns, because all of it is computable from `play`
   * and `track.duration_seconds` — the store-the-fact rule. Recomputing on read
   * costs a scan of one indexed table and means a corrected duration or a
   * re-clustered threshold is reflected everywhere at once, with no column to
   * migrate and nothing to go stale.
   *
   * The metrics, and what each answers:
   *
   * | Column | Question |
   * | --- | --- |
   * | `mean_completion_ratio` | when it plays, how much of it do you hear? |
   * | `mean_squared_completion_ratio` | same, counting whole plays far above halves |
   * | `duration_weighted_completion` | same again, tilted toward longer songs |
   * | `total_play_time` | how many seconds of your life has it had? |
   * | `skip_ratio` | how often do you reject it? |
   * | `deliberate_play_ratio` | do you seek it out, or does it just arrive? |
   *
   * `mean_squared_completion_ratio` is the one worth explaining. Squaring
   * before averaging is what makes two half-plays (0.25 each) score below one
   * whole play (1.0) despite identical listening time — Idin's point, and the
   * reason a plain mean is kept alongside rather than replaced.
   *
   * `total_play_time` sums what was actually heard, in seconds. It is
   * explicitly NOT `play_count * duration`: a two-second skip contributes two
   * seconds, not a full track. Each play is capped at the track's length for
   * the same reason the ratio is — a row logging 300 seconds against a
   * 100-second song would otherwise report listening that did not happen.
   */
  `DROP VIEW IF EXISTS track_plays`,
  `CREATE VIEW track_plays AS
     SELECT
       track.uri                                            AS track_uri,
       COUNT(play.track_uri)                                AS play_count,
       SUM(play.skipped)                                    AS skip_count,
       MAX(play.played_at)                                  AS last_played,
       SUM(MIN(play.seconds_played, track.duration_seconds)) AS total_play_time,
       AVG(MIN(play.seconds_played / track.duration_seconds, 1.0))
                                                            AS mean_completion_ratio,
       AVG(MIN(play.seconds_played / track.duration_seconds, 1.0)
           * MIN(play.seconds_played / track.duration_seconds, 1.0))
                                                            AS mean_squared_completion_ratio,
       -- EXP(exponent * LN(x)) rather than POWER(x, exponent): D1 blocks
       -- POWER outright ("not authorized to use function"), and writing it as
       -- SQRT would hard-code the 0.5 and lose the tunable exponent that is
       -- the whole point of this metric.
       --
       -- The median is a subquery rather than a stored number because it
       -- drifts as the library grows — store the fact, derive the rest.
       AVG(MIN(play.seconds_played / track.duration_seconds, 1.0)
           * MIN(play.seconds_played / track.duration_seconds, 1.0))
         * EXP(${DEFAULT_LENGTH_WEIGHT_EXPONENT} * LN(track.duration_seconds / (
             SELECT AVG(duration_seconds) FROM (
               SELECT duration_seconds FROM track WHERE duration_seconds > 0
               ORDER BY duration_seconds
               LIMIT 2 - (SELECT COUNT(*) FROM track WHERE duration_seconds > 0) % 2
               OFFSET (SELECT (COUNT(*) - 1) / 2 FROM track WHERE duration_seconds > 0)))))
                                                            AS duration_weighted_completion,
       SUM(play.skipped) * 1.0 / COUNT(play.track_uri)      AS skip_ratio,
       SUM(CASE WHEN play.reason_start IN ('clickrow', 'playbtn', 'remote')
                THEN 1 ELSE 0 END) * 1.0 / COUNT(play.track_uri)
                                                            AS deliberate_play_ratio
     FROM track
     JOIN play ON play.track_uri = track.uri
     WHERE track.duration_seconds IS NOT NULL AND track.duration_seconds > 0
     GROUP BY track.uri`,

  /*
   * Which playlists hold each track, as a comma-joined list of URIs.
   *
   * A caller asking "where do I already have this?" gets one row rather than
   * a second query per track.
   */
  `DROP VIEW IF EXISTS track_playlist_membership`,
  `CREATE VIEW track_playlist_membership AS
     SELECT
       playlist_track.track_uri                        AS track_uri,
       COUNT(*)                                        AS playlist_count,
       GROUP_CONCAT(playlist_track.playlist_uri)       AS playlist_uris
     FROM playlist_track
     GROUP BY playlist_track.track_uri`,
];
