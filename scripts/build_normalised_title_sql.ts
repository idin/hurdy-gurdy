/**
 * Emit SQL setting `normalised_title` on existing tracks.
 *
 * Uses `normaliseReleaseTitle` rather than reimplementing it, so values
 * written in bulk equal the ones `recordTracks` writes live; two
 * implementations would drift and disagree about which pressings are one song.
 *
 * Usage: npx tsx scripts/build_normalised_title_sql.ts <rows.json> > titles.sql
 * where each row is { uri, name }.
 */
import { readFileSync } from "node:fs";
import { normaliseReleaseTitle } from "../src/catalogue/normalise_release_title";

type Row = {
  uri: string;
  name: string;
};

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const rows = JSON.parse(readFileSync(process.argv[2], "utf8")) as Row[];
for (const row of rows) {
  process.stdout.write(
    `UPDATE track SET normalised_title = ${quote(normaliseReleaseTitle(row.name))} WHERE uri = ${quote(row.uri)};\n`,
  );
}
process.stderr.write(`${rows.length} titles\n`);
