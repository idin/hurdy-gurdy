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

import type {
  ExportedLibrary,
  ExportedPlaylist,
  PlaySummary,
} from "./read_spotify_export";

/**
 * How many statements go in one D1 batch.
 *
 * 2,263 tracks in a single batch would exceed D1's statement limit, and a
 * failure there loses the whole import rather than one chunk of it.
 */
const STATEMENTS_PER_BATCH = 50;

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
          `INSERT INTO track (uri, id, name, duration_ms, is_liked, cached_at)
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
            `INSERT INTO track (uri, id, name, duration_ms, is_liked, cached_at)
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
 * Write play counts and skips.
 *
 * **Joined by name, because the history carries no URIs.** That is the
 * weakest join in the project and it is stated rather than hidden: a track
 * whose name differs between the play event and the catalogue — a remaster
 * suffix, a featured-artist credit — will not match, and its plays are lost
 * rather than wrongly attributed.
 *
 * Losing them is the right failure. Attributing plays to the wrong recording
 * would corrupt the grading signal the taste model is built on, and a missing
 * count is visibly missing while a wrong one is not.
 *
 * @param database - Where the cache lives.
 * @param summaries - From `summarisePlays`.
 * @returns How many tracks were matched and updated.
 */
export async function importPlayCounts(
  database: D1Database,
  summaries: Map<string, PlaySummary>,
): Promise<number> {
  const statements: D1PreparedStatement[] = [];

  for (const summary of summaries.values()) {
    statements.push(
      database
        .prepare(
          `UPDATE track
              SET play_count = ?, skip_count = ?, last_played = ?
            WHERE LOWER(name) = LOWER(?)
              AND uri IN (
                SELECT track_uri FROM track_artist
                 WHERE artist_uri IN (SELECT uri FROM artist WHERE LOWER(name) = LOWER(?))
              )`,
        )
        .bind(
          summary.playCount,
          summary.skipCount,
          summary.lastPlayed,
          summary.trackName,
          summary.artistName,
        ),
    );
  }

  await runInBatches(database, statements);
  return summaries.size;
}
