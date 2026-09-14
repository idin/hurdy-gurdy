/**
 * Drain MusicBrainz identity resolution from the command line.
 *
 * The same logic the resolver alarm runs, driven from here so a bulk pass
 * does not depend on a connector session being open. Uses the real client so
 * there is no second implementation to drift.
 *
 * Paces itself at the documented one request per second — unlike the Worker
 * client, which must not sleep because a Worker is billed by wall time.
 *
 * Usage: npx tsx scripts/resolve_musicbrainz.ts <rows.json> <limit> > updates.sql
 */
import { readFileSync } from "node:fs";
import {
  findRecordingByIsrc,
  isMusicBrainzBusy,
  searchRecording,
} from "../src/catalogue/musicbrainz_client";

type Row = {
  uri: string;
  name: string;
  isrc: string | null;
  duration_ms: number | null;
  artist_name: string | null;
};

const REQUEST_SPACING_MS = 1_100;
const BUSY_BACKOFF_MS = 10_000;

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const rows = (JSON.parse(readFileSync(process.argv[2], "utf8")) as Row[]).slice(
  0,
  Number(process.argv[3] ?? 50),
);

let resolved = 0;
let withWork = 0;
let viaSearch = 0;

for (const row of rows) {
  try {
    let recording = row.isrc === null ? null : await findRecordingByIsrc(row.isrc);
    await sleep(REQUEST_SPACING_MS);

    if (recording === null && row.artist_name !== null && row.duration_ms !== null) {
      recording = await searchRecording({
        title: row.name,
        artistName: row.artist_name,
        durationMs: row.duration_ms,
      });
      await sleep(REQUEST_SPACING_MS);
      if (recording !== null) viaSearch += 1;
    }

    if (recording !== null) {
      resolved += 1;
      if (recording.workMbid !== null) withWork += 1;
      process.stdout.write(
        `UPDATE track SET recording_mbid = ${quote(recording.mbid)}, `
          + `work_mbid = ${recording.workMbid === null ? "NULL" : quote(recording.workMbid)}, `
          + `work_title = ${recording.workTitle === null ? "NULL" : quote(recording.workTitle)} `
          + `WHERE uri = ${quote(row.uri)};\n`,
      );
    }
  } catch (error) {
    if (isMusicBrainzBusy(error)) {
      process.stderr.write("  busy, backing off\n");
      await sleep(BUSY_BACKOFF_MS);
    }
  }
}

process.stderr.write(
  `  ${resolved}/${rows.length} resolved, ${withWork} with a work link, ${viaSearch} via search fallback\n`,
);
