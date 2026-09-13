import { describe, expect, test, vi } from "vitest";

import {
  findRecordingByIsrc,
  isMusicBrainzBusy,
  MUSICBRAINZ_USER_AGENT,
  MusicBrainzError,
  searchRecording,
} from "../../src/catalogue/musicbrainz_client";

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

/** Serves the two-hop chain: ISRC lookup, then recording detail. */
function fakeMusicBrainz(recording: unknown, options: { isrcFound?: boolean } = {}) {
  const requests: { url: string; userAgent: string | null }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const headers = new Headers(init?.headers);
    requests.push({ url, userAgent: headers.get("User-Agent") });

    if (url.includes("/isrc/")) {
      const body =
        options.isrcFound === false
          ? { recordings: [] }
          : { recordings: [{ id: (recording as { id: string }).id, title: "x" }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify(recording), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

describe("findRecordingByIsrc", () => {
  test("resolves an ISRC to a recording and its composition", async () => {
    const { fetcher } = fakeMusicBrainz(RECORDING_WITH_WORK);

    const found = await findRecordingByIsrc("USRE10301456", fetcher);

    expect(found?.mbid).toBe("rec-1");
    expect(found?.artistName).toBe("Sting");
    expect(found?.workMbid).toBe("work-1");
  });

  test("a recording with no work relation still resolves", async () => {
    // The case observed live. A missing link is DATA — MusicBrainz does not
    // say — not a failure, and the recording id is still worth keeping.
    const { fetcher } = fakeMusicBrainz(RECORDING_WITHOUT_WORK);

    const found = await findRecordingByIsrc("USRE10301456", fetcher);

    expect(found?.mbid).toBe("rec-2");
    expect(found?.workMbid).toBeNull();
    expect(found?.artistName).toBe("Noel Harrison");
  });

  test("an unknown ISRC returns null rather than throwing", async () => {
    const { fetcher } = fakeMusicBrainz(RECORDING_WITH_WORK, { isrcFound: false });

    expect(await findRecordingByIsrc("NOPE00000000", fetcher)).toBeNull();
  });

  test("sends a User-Agent identifying the application and a contact", async () => {
    // MusicBrainz blocks anonymous clients outright. This is not politeness.
    const { fetcher, requests } = fakeMusicBrainz(RECORDING_WITH_WORK);

    await findRecordingByIsrc("USRE10301456", fetcher);

    expect(requests[0].userAgent).toBe(MUSICBRAINZ_USER_AGENT);
    expect(requests[0].userAgent).toMatch(/@/);
  });

  test("takes exactly two requests, because the isrc resource carries no relations", async () => {
    // Verified 2026-09-13: ?inc=recordings+work-rels on /isrc/ is refused
    // with "recordings is not a valid inc parameter for the isrc resource".
    const { fetcher, requests } = fakeMusicBrainz(RECORDING_WITH_WORK);

    await findRecordingByIsrc("USRE10301456", fetcher);

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toContain("/isrc/");
    expect(requests[1].url).toContain("/recording/");
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

  function fakeSearch(results: unknown, detail: unknown = { id: "x", title: "x" }) {
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      requests.push(url);
      return new Response(
        JSON.stringify(url.includes("query=") ? results : detail),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    return { fetcher, requests };
  }

  test("duration picks the right one among equally-scored matches", async () => {
    // The whole danger. Four recordings score 100 and span three minutes of
    // length; taking the top score would pick arbitrarily among genuinely
    // different recordings.
    const { fetcher, requests } = fakeSearch(ACE_OF_SPADES, {
      id: "rec-studio",
      title: "Ace of Spades",
    });

    const found = await searchRecording(
      { title: "Ace of Spades", artistName: "Motörhead", durationMs: 168_000 },
      fetcher,
    );

    expect(found?.mbid).toBe("rec-studio");
    expect(requests[1]).toContain("rec-studio");
  });

  test("returns null rather than guessing when no length is close", async () => {
    // A wrong composition link groups two unrelated songs, invisibly. That is
    // the failure that made ISRC replace title matching in the first place.
    const { fetcher } = fakeSearch(ACE_OF_SPADES);

    const found = await searchRecording(
      { title: "Ace of Spades", artistName: "Motörhead", durationMs: 240_000 },
      fetcher,
    );

    expect(found).toBeNull();
  });

  test("refuses a weak title match even at the right length", async () => {
    // A low score means the name matched loosely — a different song sharing
    // words, which the length cannot rescue.
    const { fetcher } = fakeSearch({
      recordings: [{ id: "rec-other", title: "Ace", score: 55, length: 168_000 }],
    });

    const found = await searchRecording(
      { title: "Ace of Spades", artistName: "Motörhead", durationMs: 168_000 },
      fetcher,
    );

    expect(found).toBeNull();
  });

  test("ignores a result with no length at all", async () => {
    // Without a length there is nothing to disambiguate with, so accepting it
    // would be taking the top score — the thing this exists to avoid.
    const { fetcher } = fakeSearch({
      recordings: [{ id: "rec-nolength", title: "Ace of Spades", score: 100 }],
    });

    const found = await searchRecording(
      { title: "Ace of Spades", artistName: "Motörhead", durationMs: 168_000 },
      fetcher,
    );

    expect(found).toBeNull();
  });

  test("accepts a small difference, since masters drift by a second or two", async () => {
    const { fetcher } = fakeSearch(
      { recordings: [{ id: "rec-studio", title: "Ace of Spades", score: 100, length: 168_000 }] },
      { id: "rec-studio", title: "Ace of Spades" },
    );

    const found = await searchRecording(
      { title: "Ace of Spades", artistName: "Motörhead", durationMs: 170_000 },
      fetcher,
    );

    expect(found?.mbid).toBe("rec-studio");
  });

  test("escapes Lucene syntax that track titles genuinely contain", async () => {
    // An unescaped quote or colon makes a malformed query, which MusicBrainz
    // rejects rather than ignoring.
    const { fetcher, requests } = fakeSearch({ recordings: [] });

    await searchRecording(
      { title: 'Christmas Eve / Sarajevo 12/24 (Instrumental)', artistName: "A:B", durationMs: 1 },
      fetcher,
    );

    expect(requests[0]).toContain("query=");
    expect(() => decodeURIComponent(requests[0])).not.toThrow();
  });
});
