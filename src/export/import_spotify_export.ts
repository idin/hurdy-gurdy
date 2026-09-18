/**
 * Writing a parsed Spotify export into the cache.
 *
 * The export seeds; the API completes. Neither alone is enough, and knowing
 * which fills which gap is the whole of this file:
 *
 * | | Export | Web API |
 * | --- | --- | --- |
 * | Liked tracks | all 2,263 in one file | 46 paged calls |
 * | Playlist `addedDate` | yes | **never** |
 * | Play counts and skips | a year of events | **never** |
 * | Track duration | **no** | yes |
 * | Album track count | **no** | yes |
 * | Artist URI on a track | **no** | yes |
 *
 * So rows written here are deliberately incomplete: no `song_key`, no
 * `work_key`, no artist links. Those need durations and identities the file
 * does not carry, and inventing them from names is what made an earlier
 * version of the recording layer drop most of its links.
 *
 * A later API read fills them in, because every writer here uses the same
 * conflict rules the live path does — `MAX` for flags that must never be
 * lowered, `COALESCE` for values that must never be overwritten with null.
 */

import type { ExportedLibrary, ExportedPlaylist } from "./read_spotify_export";
import type { ExtendedPlay } from "./read_extended_history";
import type { SkipThreshold } from "../metrics/cluster_skip_threshold";
import { checkPlayWasSkipped } from "../metrics/play_metrics";

/**
 * How many statements go in one D1 batch.
 *
 * 2,263 tracks in a single batch would exceed D1's statement limit, and a
 * failure there loses the whole import rather than one chunk of it.
 */
const STATEMENTS_PER_BATCH = 50;

/**
 * Divisor between the export's unit and the cache's.
 *
 * The streaming history reports `ms_played`; every duration stored is seconds.
 */
const MILLISECONDS_PER_SECOND = 1000;

/** What an import wrote, for reporting back. */
export type ImportSummary = {
  likedTracks: number;
  savedAlbums: number;
  followedArtists: number;
  playlists: number;
  playlistTracks: number;
  playSummaries: number;
};

/** Run statements in batches, surfacing a failure rather than swallowing it. */
async function runInBatches(
  database: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (let index = 0; index < statements.length; index += STATEMENTS_PER_BATCH) {
    await database.batch(statements.slice(index, index + STATEMENTS_PER_BATCH));
  }
}

/**
 * Write the liked library — tracks, albums and followed artists.
 *
 * Tracks get `is_liked = 1` because that is what the file means, but no
 * `song_key`: the export omits durations, and a key built without one would
 * merge the two *Detroit Rock City* versions Idin specifically said must stay
 * apart. Left null, and a later API read supplies it.
 *
 * @param database - Where the cache lives.
 * @param library - From `readExportedLibrary`.
 * @param now - Epoch milliseconds.
 */
export async function importLibrary(
  database: D1Database,
  library: ExportedLibrary,
  now: number,
): Promise<Pick<ImportSummary, "likedTracks" | "savedAlbums" | "followedArtists">> {
  const statements: D1PreparedStatement[] = [];

  for (const track of library.tracks) {
    statements.push(
      database
        .prepare(
          `INSERT INTO track (uri, id, name, duration_seconds, is_liked, cached_at)
             VALUES (?, ?, ?, NULL, 1, ?)
           ON CONFLICT(uri) DO UPDATE SET
             name = excluded.name,
             -- Never lowered: a track already known liked stays liked, and a
             -- later API read must not be undone by an older snapshot.
             is_liked = MAX(track.is_liked, excluded.is_liked)`,
        )
        .bind(track.uri, track.uri.split(":").pop() ?? track.uri, track.track, now),
    );
  }

  for (const album of library.albums) {
    statements.push(
      database
        .prepare(
          `INSERT INTO album (uri, id, name, is_saved, cached_at)
             VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(uri) DO UPDATE SET
             name = excluded.name,
             is_saved = MAX(album.is_saved, excluded.is_saved)`,
        )
        .bind(album.uri, album.uri.split(":").pop() ?? album.uri, album.album, now),
    );
  }

  for (const artist of library.artists) {
    statements.push(
      database
        .prepare(
          `INSERT INTO artist (uri, id, name, genres, is_followed, cached_at)
             VALUES (?, ?, ?, '[]', 1, ?)
           ON CONFLICT(uri) DO UPDATE SET
             name = excluded.name,
             is_followed = MAX(artist.is_followed, excluded.is_followed)`,
        )
        .bind(artist.uri, artist.uri.split(":").pop() ?? artist.uri, artist.name, now),
    );
  }

  await runInBatches(database, statements);

  return {
    likedTracks: library.tracks.length,
    savedAlbums: library.albums.length,
    followedArtists: library.artists.length,
  };
}

/**
 * Write playlists and their contents.
 *
 * The export identifies a playlist by **name only** — there is no playlist
 * URI in the file — so a synthetic URI is derived from the name. That is the
 * one place this import invents an identifier, and it is marked as such:
 * `spotify:playlist:export:<name>`. A later API read stores the real
 * playlist under its real URI, and the two do not collide.
 *
 * The consequence worth knowing: playlist membership imported here will not
 * join to API-read playlists until something reconciles them by name. What it
 * *does* give immediately is `addedDate` per track, which the API never
 * supplies at all.
 *
 * @param database - Where the cache lives.
 * @param playlists - From `readExportedPlaylists`.
 * @param now - Epoch milliseconds.
 */
export async function importPlaylists(
  database: D1Database,
  playlists: ExportedPlaylist[],
  now: number,
): Promise<Pick<ImportSummary, "playlists" | "playlistTracks">> {
  const statements: D1PreparedStatement[] = [];
  let trackEntries = 0;

  for (const playlist of playlists) {
    const playlistUri = `spotify:playlist:export:${playlist.name}`;
    statements.push(
      database
        .prepare(
          `INSERT INTO playlist (uri, id, name, track_count, is_followed, cached_at)
             VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(uri) DO UPDATE SET
             name = excluded.name,
             track_count = COALESCE(excluded.track_count, playlist.track_count)`,
        )
        .bind(playlistUri, playlist.name, playlist.name, playlist.items.length, now),
    );

    for (const [position, item] of playlist.items.entries()) {
      // The track itself first, or the membership row points at nothing.
      // is_liked is NOT set: being in a playlist says nothing about it.
      statements.push(
        database
          .prepare(
            `INSERT INTO track (uri, id, name, duration_seconds, is_liked, cached_at)
               VALUES (?, ?, ?, NULL, 0, ?)
             ON CONFLICT(uri) DO UPDATE SET name = excluded.name`,
          )
          .bind(item.trackUri, item.trackUri.split(":").pop() ?? item.trackUri, item.trackName, now),
      );
      statements.push(
        database
          .prepare(
            `INSERT INTO playlist_track (playlist_uri, track_uri, position)
               VALUES (?, ?, ?)
             ON CONFLICT(playlist_uri, track_uri) DO UPDATE SET position = excluded.position`,
          )
          .bind(playlistUri, item.trackUri, position),
      );
      trackEntries += 1;
    }
  }

  await runInBatches(database, statements);
  return { playlists: playlists.length, playlistTracks: trackEntries };
}

/**
 * Write individual plays, with their skip judgement.
 *
 * **One row per play**, not per song. The aggregates every metric needs —
 * completion ratios, play time, skip and deliberate ratios — are computed by
 * the `track_plays` view from these rows, so the counts that used to be stored
 * are derived instead. Storing a `play_count` meant `ms_played` was thrown
 * away, and with it every metric built since.
 *
 * Plays whose track has no URI are dropped: the extended history carries one
 * on 58,327 of 58,521 plays, and the 194 without are podcasts and audiobooks
 * that are not tracks at all.
 *
 * `skipped` is computed here rather than in the view because it depends on
 * thresholds clustered from the whole import — a per-row expression cannot see
 * the distribution it belongs to. Recomputed and rewritten on every import,
 * never patched in place.
 *
 * @param database - Where the cache lives.
 * @param plays - Every play from the extended history.
 * @param threshold - From `clusterSkipThreshold` over this import's skips.
 * @param durationsByUri - Track lengths, needed to judge a skip. Plays whose
 *   track has no known duration are stored with `skipped = 0`, since no honest
 *   judgement is possible without one.
 * @param now - Epoch milliseconds.
 * @returns How many plays were written.
 */
export async function importPlays(
  database: D1Database,
  plays: ExtendedPlay[],
  threshold: SkipThreshold | null,
  durationsByUri: Map<string, number>,
  now: number,
): Promise<number> {
  const statements: D1PreparedStatement[] = [];

  for (const play of plays) {
    const trackUri = play.spotify_track_uri;
    if (trackUri === null) {
      continue;
    }

    const durationSeconds = durationsByUri.get(trackUri);
    // The export's own unit is milliseconds; everything stored is seconds.
    const secondsPlayed = play.ms_played / MILLISECONDS_PER_SECOND;
    const isSkipped =
      threshold !== null
      && durationSeconds !== undefined
      && checkPlayWasSkipped(
        { secondsPlayed, durationSeconds, reasonEnd: play.reason_end },
        threshold,
      );

    statements.push(
      database
        .prepare(
          `INSERT INTO play
             (track_uri, played_at, seconds_played, reason_start, reason_end,
              shuffle, skipped, imported_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(track_uri, played_at) DO UPDATE SET
             seconds_played = excluded.seconds_played,
             reason_start = excluded.reason_start,
             reason_end = excluded.reason_end,
             shuffle = excluded.shuffle,
             -- Rewritten, not preserved: the threshold moves as the library
             -- grows, so an older verdict must not survive a re-import.
             skipped = excluded.skipped,
             imported_at = excluded.imported_at`,
        )
        .bind(
          trackUri,
          play.ts,
          secondsPlayed,
          play.reason_start,
          play.reason_end,
          play.shuffle === null ? null : Number(play.shuffle),
          isSkipped ? 1 : 0,
          now,
        ),
    );
  }

  await runInBatches(database, statements);
  return statements.length;
}
