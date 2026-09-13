/**
 * Writing what the provider returned into the fact tables.
 *
 * The cache has two halves that are easy to confuse. `cached_response` stores
 * *answers* — this exact page, for this exact question, verbatim — so the same
 * question need not be asked twice. The fact tables store *what those answers
 * said*: that this track is liked, that it belongs to that album, that this
 * artist made it.
 *
 * Only the second half can answer a question nobody asked. "How many liked
 * tracks does Pink Floyd have" is not a Spotify endpoint and never appears in
 * any cached response; it exists only because the rows are there to count. So
 * every library read is recorded as facts on the way past, and the coverage
 * views compute from those.
 *
 * **Recording never fails a read.** A failed write here costs a coverage
 * number, and failing the caller's actual question over that would be trading
 * something they asked for against something they did not.
 */

import type { Album, Artist, Page, Playlist, Track } from "../providers/media_provider";

/**
 * How many rows one D1 batch carries.
 *
 * D1 has a bound on statements per batch, and a page of fifty tracks can
 * produce well over a hundred statements once artist links are counted.
 * Chunking keeps a large page from failing wholesale.
 */
const STATEMENTS_PER_BATCH = 50;

/**
 * Run statements in batches, ignoring failure.
 *
 * @param database - Where to write.
 * @param statements - What to run.
 */
async function runQuietly(
  database: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (let index = 0; index < statements.length; index += STATEMENTS_PER_BATCH) {
    try {
      await database.batch(statements.slice(index, index + STATEMENTS_PER_BATCH));
    } catch {
      // A missing coverage number is not worth failing the caller's question.
    }
  }
}

/**
 * Record tracks, and whether they are liked.
 *
 * `isLiked` is passed rather than inferred from the track, because the same
 * track object means different things depending on where it came from: from
 * the liked library it is liked by construction, from a playlist or a search
 * it says nothing either way. Inferring it here would silently mark every
 * track in every playlist as liked.
 *
 * An existing row's `is_liked` is only ever raised, never lowered — a track
 * seen in a playlist must not un-like a track known to be liked. Unliking is
 * handled by `forgetLikedTracks`, where it is explicit.
 *
 * @param database - Where to write.
 * @param tracks - What the provider returned.
 * @param options.isLiked - Whether these are known to be in the library.
 * @param options.now - Epoch milliseconds, stored as `cached_at`.
 */
export async function recordTracks(
  database: D1Database,
  tracks: Track[],
  options: { isLiked: boolean; now: number },
): Promise<void> {
  if (tracks.length === 0) {
    return;
  }
  const liked = options.isLiked ? 1 : 0;
  const statements: D1PreparedStatement[] = [];

  for (const track of tracks) {
    statements.push(
      database
        .prepare(
          `INSERT INTO track (uri, id, name, album_uri, duration_ms, is_liked, cached_at)
             VALUES (?, ?, ?, NULL, ?, ?, ?)
           ON CONFLICT(uri) DO UPDATE SET
             name = excluded.name,
             duration_ms = excluded.duration_ms,
             -- MAX, not excluded: a track met again in a playlist must not
             -- erase the fact that it is liked.
             is_liked = MAX(track.is_liked, excluded.is_liked),
             cached_at = excluded.cached_at`,
        )
        .bind(track.uri, track.id, track.name, track.durationMs, liked, options.now),
    );
  }

  await runQuietly(database, statements);
}

/**
 * Record albums, and link their artists.
 *
 * @param database - Where to write.
 * @param albums - What the provider returned.
 * @param options.isSaved - Whether these are saved in the library.
 * @param options.now - Epoch milliseconds.
 */
export async function recordAlbums(
  database: D1Database,
  albums: Album[],
  options: { isSaved: boolean; now: number },
): Promise<void> {
  if (albums.length === 0) {
    return;
  }
  const saved = options.isSaved ? 1 : 0;
  const statements = albums.map((album) =>
    database
      .prepare(
        `INSERT INTO album (uri, id, name, release_date, total_tracks, is_saved, cached_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uri) DO UPDATE SET
           name = excluded.name,
           release_date = excluded.release_date,
           -- COALESCE so a simplified album, which omits the count, cannot
           -- erase a real figure recorded from a full one.
           total_tracks = COALESCE(excluded.total_tracks, album.total_tracks),
           is_saved = MAX(album.is_saved, excluded.is_saved),
           cached_at = excluded.cached_at`,
      )
      .bind(
        album.uri,
        album.id,
        album.name,
        album.releaseDate,
        album.totalTrackCount,
        saved,
        options.now,
      ),
  );

  await runQuietly(database, statements);
}

/**
 * Record artists.
 *
 * `total_track_count` and `total_album_count` are deliberately left alone:
 * they are the resolver's to fill in, and a library read knows nothing about
 * them. Writing nulls here would erase a crawl that had already happened.
 *
 * @param database - Where to write.
 * @param artists - What the provider returned.
 * @param options.isFollowed - Whether these are followed.
 * @param options.now - Epoch milliseconds.
 */
export async function recordArtists(
  database: D1Database,
  artists: Artist[],
  options: { isFollowed: boolean; now: number },
): Promise<void> {
  if (artists.length === 0) {
    return;
  }
  const followed = options.isFollowed ? 1 : 0;
  const statements = artists.map((artist) =>
    database
      .prepare(
        `INSERT INTO artist (uri, id, name, genres, is_followed, cached_at)
           VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(uri) DO UPDATE SET
           name = excluded.name,
           genres = excluded.genres,
           is_followed = MAX(artist.is_followed, excluded.is_followed),
           cached_at = excluded.cached_at`,
      )
      .bind(
        artist.uri,
        artist.id,
        artist.name,
        JSON.stringify(artist.genres),
        followed,
        options.now,
      ),
  );

  await runQuietly(database, statements);
}

/**
 * Record playlists.
 *
 * @param database - Where to write.
 * @param playlists - What the provider returned.
 * @param options.now - Epoch milliseconds.
 */
export async function recordPlaylists(
  database: D1Database,
  playlists: Playlist[],
  options: { now: number },
): Promise<void> {
  if (playlists.length === 0) {
    return;
  }
  const statements = playlists.map((playlist) =>
    database
      .prepare(
        `INSERT INTO playlist (uri, id, name, owner_name, track_count, is_followed, cached_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(uri) DO UPDATE SET
           name = excluded.name,
           owner_name = excluded.owner_name,
           track_count = COALESCE(excluded.track_count, playlist.track_count),
           cached_at = excluded.cached_at`,
      )
      .bind(
        playlist.uri,
        playlist.id,
        playlist.name,
        playlist.ownerName,
        playlist.trackCount,
        options.now,
      ),
  );

  await runQuietly(database, statements);
}

/**
 * Record which tracks a playlist holds.
 *
 * This is what answers "I have this in three playlists but never liked it" —
 * a state Spotify publishes no endpoint for.
 *
 * Only ever adds. A page of a playlist says what is on that page, not what is
 * absent from the playlist, so removing rows on the strength of one page
 * would delete the rest of the playlist from the cache.
 *
 * @param database - Where to write.
 * @param playlistUri - The playlist these tracks came from.
 * @param page - The page of tracks.
 * @param options.now - Epoch milliseconds.
 */
export async function recordPlaylistTracks(
  database: D1Database,
  playlistUri: string,
  page: Page<Track>,
  options: { now: number },
): Promise<void> {
  if (page.items.length === 0) {
    return;
  }

  // The tracks themselves first: a playlist membership row pointing at a
  // track nobody recorded would join to nothing in the views.
  await recordTracks(database, page.items, { isLiked: false, now: options.now });

  const statements = page.items.map((track, index) =>
    database
      .prepare(
        `INSERT INTO playlist_track (playlist_uri, track_uri, position)
           VALUES (?, ?, ?)
         ON CONFLICT(playlist_uri, track_uri) DO UPDATE SET position = excluded.position`,
      )
      .bind(playlistUri, track.uri, index),
  );

  await runQuietly(database, statements);
}

/**
 * Link tracks to the artists that made them, by name.
 *
 * A compromise, and worth naming as one: the shared `Track` shape carries
 * `artistNames` but no artist URIs, because names are what a caller wants to
 * read. So a link can only be made to an artist already recorded under that
 * name. An artist nobody has seen yet is skipped, and the link appears once a
 * later read records them.
 *
 * The alternative — widening `Track` to carry artist URIs — is the better fix
 * and belongs with the resolver work, where identity stops being a name.
 *
 * @param database - Where to write.
 * @param tracks - Tracks whose artists should be linked.
 */
export async function linkTracksToKnownArtists(
  database: D1Database,
  tracks: Track[],
): Promise<void> {
  if (tracks.length === 0) {
    return;
  }
  const statements = tracks.flatMap((track) =>
    track.artistNames.map((artistName) =>
      database
        .prepare(
          `INSERT OR IGNORE INTO track_artist (track_uri, artist_uri)
             SELECT ?, uri FROM artist WHERE name = ?`,
        )
        .bind(track.uri, artistName),
    ),
  );

  await runQuietly(database, statements);
}

/**
 * Mark tracks as no longer liked.
 *
 * The explicit counterpart to `recordTracks`, which only ever raises
 * `is_liked`. Unliking has to say so, because no read can distinguish "not
 * liked" from "not seen in the liked library on this page".
 *
 * @param database - Where to write.
 * @param uris - Tracks to unlike.
 */
export async function forgetLikedTracks(
  database: D1Database,
  uris: string[],
): Promise<void> {
  if (uris.length === 0) {
    return;
  }
  const statements = uris.map((uri) =>
    database.prepare(`UPDATE track SET is_liked = 0 WHERE uri = ?`).bind(uri),
  );
  await runQuietly(database, statements);
}
