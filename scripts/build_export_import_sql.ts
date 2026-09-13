/**
 * Turn the Spotify export into SQL that `wrangler d1 execute --file` can run.
 *
 * Chosen over an HTTP import endpoint deliberately: an endpoint would need
 * authentication, would have to accept multi-megabyte bodies, and would add a
 * write surface to a public worker for something that runs once. Generated
 * SQL has none of those properties and can be read before it is executed.
 *
 * The parsing goes through `read_spotify_export.ts` rather than being redone
 * here, so the traps that file documents — a null track on a local file, the
 * missing URIs in the play history — are handled once.
 *
 * Usage:
 *   npx tsx scripts/build_export_import_sql.ts <export-directory> > import.sql
 */

import { readFileSync, existsSync } from "node:fs";

import {
  readExportedLibrary,
  readExportedPlaylists,
  readExportedPlays,
  summarisePlays,
} from "../src/export/read_spotify_export";

/** SQL string literal: single quotes doubled, which is the whole escape. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function findSpotifyId(uri: string): string {
  return uri.split(":").pop() ?? uri;
}

const directory = process.argv[2];
if (directory === undefined) {
  throw new Error("Usage: build_export_import_sql.ts <export-directory>");
}

const now = Date.now();
const statements: string[] = [];

// --- Liked library -------------------------------------------------------

const library = readExportedLibrary(
  readFileSync(`${directory}/YourLibrary.json`, "utf8"),
);

for (const track of library.tracks) {
  statements.push(
    `INSERT INTO track (uri, id, name, duration_ms, is_liked, cached_at)
       VALUES (${quote(track.uri)}, ${quote(findSpotifyId(track.uri))}, ${quote(track.track)}, NULL, 1, ${now})
     ON CONFLICT(uri) DO UPDATE SET
       name = excluded.name,
       is_liked = MAX(track.is_liked, excluded.is_liked);`,
  );
}

for (const album of library.albums) {
  statements.push(
    `INSERT INTO album (uri, id, name, is_saved, cached_at)
       VALUES (${quote(album.uri)}, ${quote(findSpotifyId(album.uri))}, ${quote(album.album)}, 1, ${now})
     ON CONFLICT(uri) DO UPDATE SET
       name = excluded.name,
       is_saved = MAX(album.is_saved, excluded.is_saved);`,
  );
}

for (const artist of library.artists) {
  statements.push(
    `INSERT INTO artist (uri, id, name, genres, is_followed, cached_at)
       VALUES (${quote(artist.uri)}, ${quote(findSpotifyId(artist.uri))}, ${quote(artist.name)}, '[]', 1, ${now})
     ON CONFLICT(uri) DO UPDATE SET
       name = excluded.name,
       is_followed = MAX(artist.is_followed, excluded.is_followed);`,
  );
}

// --- Playlists -----------------------------------------------------------

const playlists = readExportedPlaylists(
  readFileSync(`${directory}/Playlist1.json`, "utf8"),
);

for (const playlist of playlists) {
  const playlistUri = `spotify:playlist:export:${playlist.name}`;
  statements.push(
    `INSERT INTO playlist (uri, id, name, track_count, is_followed, cached_at)
       VALUES (${quote(playlistUri)}, ${quote(playlist.name)}, ${quote(playlist.name)}, ${playlist.items.length}, 1, ${now})
     ON CONFLICT(uri) DO UPDATE SET
       name = excluded.name,
       track_count = COALESCE(excluded.track_count, playlist.track_count);`,
  );

  for (const [position, item] of playlist.items.entries()) {
    // is_liked stays 0 here: being in a playlist is not evidence of a like,
    // and MAX means a genuine like already recorded survives this.
    statements.push(
      `INSERT INTO track (uri, id, name, duration_ms, is_liked, cached_at)
         VALUES (${quote(item.trackUri)}, ${quote(findSpotifyId(item.trackUri))}, ${quote(item.trackName)}, NULL, 0, ${now})
       ON CONFLICT(uri) DO UPDATE SET name = excluded.name;`,
    );
    statements.push(
      `INSERT INTO playlist_track (playlist_uri, track_uri, position)
         VALUES (${quote(playlistUri)}, ${quote(item.trackUri)}, ${position})
       ON CONFLICT(playlist_uri, track_uri) DO UPDATE SET position = excluded.position;`,
    );
  }
}

// --- Play counts ---------------------------------------------------------

const plays = [0, 1].flatMap((index) => {
  const path = `${directory}/StreamingHistory_music_${index}.json`;
  return existsSync(path) ? readExportedPlays(readFileSync(path, "utf8")) : [];
});

for (const [playKey, summary] of summarisePlays(plays)) {
  // Written once per SONG, not once per pressing. Matching on name and
  // updating every row that matched gave three copies of "Eye In The Sky"
  // 21 plays each — 450 duplicated names among 2,955 counted rows on
  // 2026-09-13. A play belongs to the recording; the track_plays view joins
  // it back to whichever pressings share the name.
  statements.push(
    `INSERT INTO song_plays (play_key, artist_name, track_name, play_count, skip_count, last_played, imported_at)
       VALUES (${quote(playKey)}, ${quote(summary.artistName)}, ${quote(summary.trackName)}, ${summary.playCount}, ${summary.skipCount}, ${quote(summary.lastPlayed)}, ${now})
     ON CONFLICT(play_key) DO UPDATE SET
       play_count = excluded.play_count,
       skip_count = excluded.skip_count,
       last_played = excluded.last_played,
       imported_at = excluded.imported_at;`,
  );
}

process.stdout.write(statements.join("\n"));
process.stderr.write(
  `${statements.length} statements: `
    + `${library.tracks.length} liked tracks, ${library.albums.length} albums, `
    + `${library.artists.length} artists, ${playlists.length} playlists, `
    + `${plays.length} plays\n`,
);
