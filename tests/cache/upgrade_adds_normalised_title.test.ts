import { env } from "cloudflare:workers";
import { afterAll, describe, expect, test } from "vitest";

import { MEDIA_CACHE_SCHEMA } from "../../src/cache/media_cache_schema";
import { prepareMediaCache } from "../../src/cache/media_cache_store";
import { linkTrackRelations } from "../../src/cache/record_library_facts";
import type { Track } from "../../src/providers/media_provider";

/**
 * Upgrading a live database that predates `track.normalised_title`.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an old `track` table alone, so the
 * column and its index must arrive through a migration. A fresh-database test
 * cannot see a missing migration, which is why this builds the old shape by
 * hand: the current schema, then `track` replaced by its pre-column form.
 * Rows written before the column existed have NULL there; each must still
 * count as its own song, not vanish or merge on a NULL comparison.
 *
 * The test ends with the database prepared and emptied, the state every other
 * file's `beforeEach` expects.
 */

const database = (env as { MEDIA_CACHE: D1Database }).MEDIA_CACHE;
const NOW = Date.parse("2026-09-26T12:00:00Z");
const QUEEN = { uri: "spotify:artist:1dfeR4HaWDbWqFHLkxsg1d", name: "Queen" };

/** `track` exactly as it was before this column was added. */
const PRE_MIGRATION_TRACK_TABLE = `CREATE TABLE track (
  uri TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, album_uri TEXT,
  duration_seconds REAL, is_liked INTEGER NOT NULL DEFAULT 0, liked_at TEXT,
  song_key TEXT, isrc TEXT, recording_mbid TEXT, work_mbid TEXT, work_title TEXT,
  play_count INTEGER, skip_count INTEGER, last_played TEXT, cached_at INTEGER NOT NULL
)`;

function queenTrack(uri: string): Track {
  return {
    uri,
    inLibrary: true,
    id: uri.split(":").pop()!,
    name: "Bohemian Rhapsody",
    artists: [QUEEN],
    artistNames: [QUEEN.name],
    albumName: "A Night at the Opera",
    albumUri: "spotify:album:nightopera",
    albumTrackCount: null,
    durationSeconds: 354.0,
    isrc: null,
  };
}

afterAll(async () => {
  for (const table of ["track", "track_artist", "artist", "album", "album_artist"]) {
    await database.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("upgrading a database without normalised_title", () => {
  test("the column and index arrive and old rows each count as their own song", async () => {
    await database.batch(MEDIA_CACHE_SCHEMA.map((statement) => database.prepare(statement)));
    await database.prepare(`DROP TABLE track`).run();
    await database.prepare(PRE_MIGRATION_TRACK_TABLE).run();
    const oldTracks = [queenTrack("spotify:track:old1"), queenTrack("spotify:track:old2")];
    for (const track of oldTracks) {
      await database
        .prepare(
          `INSERT INTO track (uri, id, name, duration_seconds, is_liked, cached_at)
           VALUES (?, ?, ?, ?, 1, ?)`,
        )
        .bind(track.uri, track.id, track.name, track.durationSeconds, NOW)
        .run();
    }
    await linkTrackRelations(database, oldTracks, { now: NOW });

    await prepareMediaCache(database);

    const columns = await database.prepare(`PRAGMA table_info(track)`).all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toContain("normalised_title");
    const index = await database
      .prepare(`SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'track_normalised_title'`)
      .first<{ tbl_name: string }>();
    expect(index?.tbl_name).toBe("track");

    const nulls = await database
      .prepare(`SELECT COUNT(*) AS total FROM track WHERE normalised_title IS NULL`)
      .first<{ total: number }>();
    expect(nulls?.total).toBe(2);
    const coverage = await database
      .prepare(`SELECT liked_track_count FROM artist_coverage WHERE artist_uri = ?`)
      .bind(QUEEN.uri)
      .first<{ liked_track_count: number }>();
    expect(coverage?.liked_track_count).toBe(2);
  });
});
