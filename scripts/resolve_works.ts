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

/**
 * How many times one recording may be retried before it is given up on.
 *
 * Bounded because the first version of this script was not, and stalled: a
 * bare `continue` on a rate-limit refusal retried the same row forever, so one
 * unlucky recording blocked the remaining 1,167. Observed 2026-09-18 — the
 * pass advanced ten rows in forty minutes while a fresh request to the same
 * endpoint returned 200 immediately, because the retries were themselves what
 * kept the client throttled.
 *
 * The same shape as the resolver bug fixed that morning: an unbounded retry
 * with nothing counting it looks identical to work in progress.
 */
const MAXIMUM_ATTEMPTS_PER_RECORDING = 3;

/**
 * Backoff between successive retries of one recording.
 *
 * Doubling, so a throttled client stops adding to the traffic that throttled
 * it. A flat retry is what produced the stall.
 */
function findBackoffDelay(attempt: number): number {
  return BUSY_BACKOFF_MILLISECONDS * 2 ** (attempt - 1);
}

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

  let givenUp = 0;

  for (const [index, row] of rows.entries()) {
    // Bounded, and the bound is the point: an unbounded retry here stalled an
    // entire pass on one recording.
    for (let attempt = 1; attempt <= MAXIMUM_ATTEMPTS_PER_RECORDING; attempt += 1) {
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
        break;
      } catch (error) {
        if (isMusicBrainzBusy(error) && attempt < MAXIMUM_ATTEMPTS_PER_RECORDING) {
          await sleep(findBackoffDelay(attempt));
          continue;
        }
        // Out of attempts, or a failure retrying cannot fix. Counted either
        // way, so the totals always add up to the number of rows — a pass
        // whose figures do not reconcile is a pass that lost track of itself.
        if (isMusicBrainzBusy(error)) {
          givenUp += 1;
        } else {
          withoutWork += 1;
        }
        break;
      }
    }

    if ((index + 1) % 100 === 0) {
      console.error(
        `  ${index + 1}/${rows.length}  works=${withWork} none=${withoutWork} gaveUp=${givenUp}`,
      );
    }
    await sleep(REQUEST_SPACING_MILLISECONDS);
  }

  console.error(
    `\n  DONE ${rows.length}: ${withWork} works, ${withoutWork} without, ${givenUp} gave up`,
  );
}

void main();
