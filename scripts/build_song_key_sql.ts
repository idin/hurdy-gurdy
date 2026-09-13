/**
 * Emit SQL that sets `song_key` for tracks that have a duration but no key.
 *
 * Uses `buildSongKey` rather than reimplementing the rules, so the keys
 * written here are identical to the ones the live path writes. A second
 * implementation would drift, and the two would disagree about which
 * pressings are the same recording.
 *
 * Usage: npx tsx scripts/build_song_key_sql.ts <rows.json> > keys.sql
 */
import { readFileSync } from "node:fs";
import { buildSongKey } from "../src/catalogue/normalise_release_title";

type Row = { uri: string; name: string; duration_ms: number };

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const rows = JSON.parse(readFileSync(process.argv[2], "utf8")) as Row[];
for (const row of rows) {
  const key = buildSongKey({ title: row.name, durationMs: row.duration_ms });
  process.stdout.write(
    `UPDATE track SET song_key = ${quote(key)} WHERE uri = ${quote(row.uri)};\n`,
  );
}
process.stderr.write(`${rows.length} keys\n`);
