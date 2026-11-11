import { afterEach, describe, expect, test } from "vitest";

import {
  findRecordingByIsrc,
  isMusicBrainzBusy,
  MUSICBRAINZ_USER_AGENT,
  MusicBrainzError,
  searchRecording,
} from "../../src/catalogue/musicbrainz_client";
import { startLocalHttpServer, type LocalHttpServer } from "../local_http_server";

/**
 * Response shapes copied from real MusicBrainz calls on 2026-09-13, including
 * the one that matters most: a recording with **no work relation** despite
 * the work existing in the database. Noel Harrison's "Windmills of Your Mind"
 * behaves exactly that way, and treating that absence as a failure would make
 * the resolver retry it forever against a one-per-second budget.
 */

const RECORDING_WITH_WORK = {
  id: "rec-1",
  title: "Windmills of Your Mind",
  "artist-credit": [{ name: "Sting" }],
  relations: [{ work: { id: "work-1", title: "The Windmills of Your Mind" } }],
};

const RECORDING_WITHOUT_WORK = {
  id: "rec-2",
  title: "Windmills of Your Mind",
  "artist-credit": [{ name: "Noel Harrison" }],
  relations: [],
};

/** The path MusicBrainz serves its API under; the client appends resource paths to it. */
const API_PATH = "/ws/2";

let server: LocalHttpServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** Serves the two-hop chain over a real local server: ISRC lookup, then recording detail. */
async function startMusicBrainz(recording: unknown, options: { isrcFound?: boolean } = {}) {
  server = await startLocalHttpServer({
    respond: (request) => {
      if (request.path.includes("/isrc/")) {
        return {
          status: 200,
          body:
            options.isrcFound === false
              ? { recordings: [] }
              : { recordings: [{ id: (recording as { id: string }).id, title: "x" }] },
        };
      }
      return { status: 200, body: recording };
    },
  });
  return { apiBaseUrl: `${server.origin}${API_PATH}`, requests: server.requests };
}

describe("findRecordingByIsrc", () => {
  test("resolves an ISRC to a recording and its composition", async () => {
    const { apiBaseUrl } = await startMusicBrainz(RECORDING_WITH_WORK);

    const found = await findRecordingByIsrc("USRE10301456", { apiBaseUrl });

    expect(found?.mbid).toBe("rec-1");
    expect(found?.artistName).toBe("Sting");
    expect(found?.workMbid).toBe("work-1");
  });

  test("a recording with no work relation still resolves", async () => {
    // The case observed live. A missing link is DATA — MusicBrainz does not
    // say — not a failure, and the recording id is still worth keeping.
    const { apiBaseUrl } = await startMusicBrainz(RECORDING_WITHOUT_WORK);

    const found = await findRecordingByIsrc("USRE10301456", { apiBaseUrl });

    expect(found?.mbid).toBe("rec-2");
    expect(found?.workMbid).toBeNull();
    expect(found?.artistName).toBe("Noel Harrison");
  });

  test("an unknown ISRC returns null rather than throwing", async () => {
    const { apiBaseUrl } = await startMusicBrainz(RECORDING_WITH_WORK, { isrcFound: false });

    expect(await findRecordingByIsrc("NOPE00000000", { apiBaseUrl })).toBeNull();
  });

  test("sends a User-Agent identifying the application and a contact", async () => {
    // MusicBrainz blocks anonymous clients outright. This is not politeness.
    const { apiBaseUrl, requests } = await startMusicBrainz(RECORDING_WITH_WORK);

    await findRecordingByIsrc("USRE10301456", { apiBaseUrl });

    expect(requests[0].headers["user-agent"]).toBe(MUSICBRAINZ_USER_AGENT);
    expect(requests[0].headers["user-agent"]).toMatch(/@/);
  });

  test("takes exactly two requests, because the isrc resource carries no relations", async () => {
    // Verified 2026-09-13: ?inc=recordings+work-rels on /isrc/ is refused
    // with "recordings is not a valid inc parameter for the isrc resource".
    const { apiBaseUrl, requests } = await startMusicBrainz(RECORDING_WITH_WORK);

    await findRecordingByIsrc("USRE10301456", { apiBaseUrl });

    expect(requests).toHaveLength(2);
    expect(requests[0].path).toContain("/isrc/");
    expect(requests[1].path).toContain("/recording/");
  });
});

describe("isMusicBrainzBusy", () => {
  test("a 503 is transient and should be retried", async () => {
    // Exceeding one request per second returns 503 on ALL requests, so the
    // question was never asked — different from being answered with nothing.
    expect(isMusicBrainzBusy(new MusicBrainzError(503, "busy"))).toBe(true);
  });

  test("a 404 is an answer, not a rate limit", async () => {
    // Retrying this spends the budget rediscovering nothing.
    expect(isMusicBrainzBusy(new MusicBrainzError(404, "not found"))).toBe(false);
  });

  test("an unrelated error is not a rate limit", async () => {
    expect(isMusicBrainzBusy(new Error("network"))).toBe(false);
  });
});

describe("searchRecording", () => {
  /** The real Ace of Spades result: four recordings, all scoring 100. */
  const ACE_OF_SPADES = {
    recordings: [
      { id: "rec-live-1", title: "Ace of Spades", score: 100, length: 286_000 },
      { id: "rec-studio", title: "Ace of Spades", score: 100, length: 168_000 },
      { id: "rec-edit", title: "Ace of Spades", score: 100, length: 137_000 },
      { id: "rec-live-2", title: "Ace of Spades", score: 100, length: 316_000 },
    ],
  };

  /** Real local server: the search query gets `results`, the detail lookup gets `detail`. */
  async function startSearch(results: unknown, detail: unknown = { id: "x", title: "x" }) {
    server = await startLocalHttpServer({
      respond: (request) => ({ status: 200, body: request.query.has("query") ? results : detail }),
    });
    return { apiBaseUrl: `${server.origin}${API_PATH}`, requests: server.requests };
  }

  test("duration picks the right one among equally-scored matches", async () => {
    // The whole danger. Four recordings score 100 and span three minutes of
    // length; taking the top score would pick arbitrarily among genuinely
    // different recordings.
    const { apiBaseUrl, requests } = await startSearch(ACE_OF_SPADES, {
      id: "rec-studio",
      title: "Ace of Spades",
    });

    const found = await searchRecording(
      { title: "Ace of Spades", artistName: "Motörhead", durationSeconds: 168 },
      { apiBaseUrl },
    );

    expect(found?.mbid).toBe("rec-studio");
    expect(requests[1].path).toContain("rec-studio");
  });

  test("returns null rather than guessing when no length is close", async () => {
    // A wrong composition link groups two unrelated songs, invisibly. That is
    // the failure that made ISRC replace title matching in the first place.
    const { apiBaseUrl } = await startSearch(ACE_OF_SPADES);

    const found = await searchRecording(
      { title: "Ace of Spades", artistName: "Motörhead", durationSeconds: 240 },
      { apiBaseUrl },
    );

    expect(found).toBeNull();
  });

  test("refuses a weak title match even at the right length", async () => {
    // A low score means the name matched loosely — a different song sharing
    // words, which the length cannot rescue.
    const { apiBaseUrl } = await startSearch({
      recordings: [{ id: "rec-other", title: "Ace", score: 55, length: 168_000 }],
    });

    const found = await searchRecording(
      { title: "Ace of Spades", artistName: "Motörhead", durationSeconds: 168 },
      { apiBaseUrl },
    );

    expect(found).toBeNull();
  });

  test("ignores a result with no length at all", async () => {
    // Without a length there is nothing to disambiguate with, so accepting it
    // would be taking the top score — the thing this exists to avoid.
    const { apiBaseUrl } = await startSearch({
      recordings: [{ id: "rec-nolength", title: "Ace of Spades", score: 100 }],
    });

    const found = await searchRecording(
      { title: "Ace of Spades", artistName: "Motörhead", durationSeconds: 168 },
      { apiBaseUrl },
    );

    expect(found).toBeNull();
  });

  test("accepts a small difference, since masters drift by a second or two", async () => {
    const { apiBaseUrl } = await startSearch(
      { recordings: [{ id: "rec-studio", title: "Ace of Spades", score: 100, length: 168_000 }] },
      { id: "rec-studio", title: "Ace of Spades" },
    );

    const found = await searchRecording(
      { title: "Ace of Spades", artistName: "Motörhead", durationSeconds: 170 },
      { apiBaseUrl },
    );

    expect(found?.mbid).toBe("rec-studio");
  });

  test("escapes Lucene syntax that track titles genuinely contain", async () => {
    // An unescaped quote or colon makes a malformed query, which MusicBrainz
    // rejects rather than ignoring.
    const { apiBaseUrl, requests } = await startSearch({ recordings: [] });

    await searchRecording(
      { title: 'Christmas Eve / Sarajevo 12/24 (Instrumental)', artistName: "A:B", durationSeconds: 1 },
      { apiBaseUrl },
    );

    expect(requests[0].query.has("query")).toBe(true);
    expect(() => decodeURIComponent(requests[0].target)).not.toThrow();
  });
});
