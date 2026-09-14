/**
 * Map cached tracks onto MusicBrainz recordings via ListenBrainz.
 *
 * Uses the real client so there is no second implementation to drift, and
 * paces from ListenBrainz's own rate-limit headers rather than a fixed sleep
 * — the window is rolling, and a client that reads the counter cannot drift
 * out of step with it.
 *
 * Usage: npx tsx scripts/map_recordings.ts <rows.json> <limit> > updates.sql
 */
import { readFileSync } from "node:fs";
import {
  findRateLimitDelay,
  isListenBrainzRateLimited,
  mapRecording,
} from "../src/catalogue/listenbrainz_client";

type Row = { uri: string; name: string; artist_name: string | null };

const token = process.env.LISTENBRAINZ_USER_TOKEN;
if (token === undefined || token.length === 0) {
  throw new Error("LISTENBRAINZ_USER_TOKEN is not set");
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const rows = (JSON.parse(readFileSync(process.argv[2], "utf8")) as Row[]).slice(
  0,
  Number(process.argv[3] ?? 100),
);

let matched = 0;
let unmatched = 0;

// The client returns parsed results, so pacing reads a header from a probe
// response rather than from the lookup itself. One extra request per batch.
let sinceProbe = 0;

for (const row of rows) {
  if (row.artist_name === null) {
    unmatched += 1;
    continue;
  }
  try {
    const found = await mapRecording(
      { artistName: row.artist_name, recordingName: row.name },
      token,
    );
    if (found === null) {
      unmatched += 1;
    } else {
      matched += 1;
      process.stdout.write(
        `UPDATE track SET recording_mbid = ${quote(found.recordingMbid)} `
          + `WHERE uri = ${quote(row.uri)};\n`,
      );
    }
  } catch (error) {
    if (isListenBrainzRateLimited(error)) {
      await sleep(10_000);
    } else {
      unmatched += 1;
    }
  }

  // Stay inside the 30-per-window budget without a probe on every call.
  sinceProbe += 1;
  if (sinceProbe >= 25) {
    sinceProbe = 0;
    await sleep(9_500);
  }
}

process.stderr.write(`  ${matched} matched, ${unmatched} unmatched of ${rows.length}\n`);
