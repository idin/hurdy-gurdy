import { describe, expect, test, vi } from "vitest";

import {
  findRecordingByIsrc,
  isMusicBrainzBusy,
  MUSICBRAINZ_USER_AGENT,
  MusicBrainzError,
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
