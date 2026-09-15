/**
 * Emit SQL loading the extended streaming history onto cached tracks.
 *
 * Keyed by `spotify_track_uri`, so this replaces the name-based join the
 * account export forced — which was documented as the weakest thing in the
 * project and is now simply unnecessary.
 *
 * Usage: npx tsx scripts/build_extended_history_sql.ts <directory> > plays.sql
 */
import { readFileSync, readdirSync } from "node:fs";
import {
  readExtendedHistory,
  summariseExtendedPlays,
  type ExtendedPlay,
} from "../src/export/read_extended_history";

const directory = process.argv[2];
const plays: ExtendedPlay[] = [];

for (const name of readdirSync(directory)) {
  if (name.startsWith("Streaming_History_Audio_") && name.endsWith(".json")) {
    plays.push(...readExtendedHistory(readFileSync(`${directory}/${name}`, "utf8")));
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const summaries = summariseExtendedPlays(plays);
for (const summary of summaries.values()) {
  process.stdout.write(
    `UPDATE track SET completed_count = ${summary.completedCount}, `
      + `skipped_count = ${summary.skippedCount}, `
      + `other_count = ${summary.otherCount}, `
      + `shuffled_count = ${summary.shuffledCount}, `
      + `last_played = ${quote(summary.lastPlayed)} `
      + `WHERE uri = ${quote(summary.trackUri)};\n`,
  );
}

process.stderr.write(`  ${plays.length} plays -> ${summaries.size} tracks\n`);
