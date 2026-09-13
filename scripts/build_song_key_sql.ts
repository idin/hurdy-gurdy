/**
 * Emit SQL setting `song_key` from the code's own identity rules.
 *
 * Uses `buildSongKey` rather than reimplementing it, so keys written in bulk
 * are identical to the ones the live path writes. Two implementations would
 * drift, and would then disagree about which pressings are one recording.
 *
 * Usage: npx tsx scripts/build_song_key_sql.ts <rows.json> > keys.sql
 */
import { readFileSync } from "node:fs";
import { buildSongKey } from "../src/catalogue/normalise_release_title";

type Row = {
  uri: string;
  name: string;
  duration_ms: number | null;
  isrc: string | null;
  artist_uris: string | null;
};

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const rows = JSON.parse(readFileSync(process.argv[2], "utf8")) as Row[];
for (const row of rows) {
  const key = buildSongKey({
    title: row.name,
    durationMs: row.duration_ms ?? 0,
    isrc: row.isrc,
    artistUris: row.artist_uris === null ? [] : row.artist_uris.split(","),
  });
  process.stdout.write(
    `UPDATE track SET song_key = ${quote(key)} WHERE uri = ${quote(row.uri)};\n`,
  );
}
process.stderr.write(`${rows.length} keys\n`);
