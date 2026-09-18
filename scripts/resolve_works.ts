/**
 * Fill in the composition behind each resolved recording.
 *
 * A recording MBID names one performance; a **work** names the song itself,
 * which is what groups Noel Harrison's *Windmills of Your Mind* with Sting's
 * as the same composition while ISRC correctly keeps them apart as
 * recordings. It is the level Spotify does not model at all.
 *
 * Separate from `map_recordings.ts` because the two hit different services at
 * different rates: name-to-recording goes through ListenBrainz at thirty
 * requests per nine seconds, while recording-to-work is MusicBrainz at one
 * per second. Running them as one pass would pace the fast half at the slow
 * half's rate.
 *
 * Uses `findRecordingDetail` — the same call the resolver makes — so there is
 * no second implementation to drift. A scratchpad script that wrote only
 * `recording_mbid` and skipped this step is exactly why this file exists.
 *
 * Usage: npx tsx scripts/resolve_works.ts <rows.json> > updates.sql
 */
import { readFileSync } from "node:fs";

import { findRecordingDetail, isMusicBrainzBusy } from "../src/catalogue/musicbrainz_client";

type Row = { uri: string; recording_mbid: string };

/**
 * Seconds between requests.
 *
 * MusicBrainz documents one request per second globally per IP, and exceeding
 * it returns 503 on *every* request until the rate drops — so a burst does
 * not merely fail itself, it takes out everything alongside it. 1.2 leaves
 * headroom for clock drift.
 */
const REQUEST_SPACING_MILLISECONDS = 1200;

/** How long to wait out a rate-limit refusal before trying again. */
const BUSY_BACKOFF_MILLISECONDS = 5000;

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Escape a value for single-quoted SQL. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (inputPath === undefined) {
    throw new Error("Usage: npx tsx scripts/resolve_works.ts <rows.json>");
  }

  const rows = JSON.parse(readFileSync(inputPath, "utf8")) as Row[];
  let withWork = 0;
  let withoutWork = 0;

  for (const [index, row] of rows.entries()) {
    try {
      const detail = await findRecordingDetail(row.recording_mbid);
      if (detail.workMbid !== null) {
        withWork += 1;
        const title = detail.workTitle === null ? "NULL" : quote(detail.workTitle);
        console.log(
          `UPDATE track SET work_mbid = ${quote(detail.workMbid)}, work_title = ${title} `
            + `WHERE uri = ${quote(row.uri)};`,
        );
      } else {
        // Not a failure. Recording-to-work is among the least complete
        // relations in MusicBrainz, and a null means "it does not say".
        withoutWork += 1;
      }
    } catch (error) {
      if (isMusicBrainzBusy(error)) {
        await sleep(BUSY_BACKOFF_MILLISECONDS);
        continue;
      }
      withoutWork += 1;
    }

    if ((index + 1) % 100 === 0) {
      console.error(`  ${index + 1}/${rows.length}  works=${withWork} none=${withoutWork}`);
    }
    await sleep(REQUEST_SPACING_MILLISECONDS);
  }

  console.error(`\n  DONE ${rows.length}: ${withWork} works, ${withoutWork} without`);
}

void main();
