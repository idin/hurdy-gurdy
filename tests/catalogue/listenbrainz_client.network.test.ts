import { afterEach, describe, expect, test } from "vitest";

import {
  findRateLimitDelay,
  isListenBrainzRateLimited,
  ListenBrainzError,
  mapRecording,
} from "../../src/catalogue/listenbrainz_client";
import { startLocalHttpServer, type LocalHttpServer } from "../local_http_server";

/**
 * Response shapes copied from live calls on 2026-09-13, including the two
 * that matter: Noel Harrison's "Windmills of Your Mind", which MusicBrainz's
 * own service refused with 503s, and the empty-body form the mapper returns
 * when it cannot place a track.
 */

const MATCHED = {
  artist_credit_name: "Noel Harrison",
  artist_mbids: ["edc02054-b996-4ce6-a6b3-eba7ae8ed5bf"],
  recording_mbid: "8e0bed40-e48b-44c1-8fbe-a6194e5cf103",
  recording_name: "Windmills of Your Mind",
  release_mbid: "ccc54196-f4be-435d-b361-647a4111f326",
  release_name: "Life Is a Dream",
};

/** The path ListenBrainz serves its API under; the client appends `/metadata/lookup/` to it. */
const API_PATH = "/1";

let server: LocalHttpServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** Starts a real local server that answers every request with `body`, and returns what the client needs to reach it. */
async function startMapper(body: unknown, status = 200) {
  server = await startLocalHttpServer({ respond: () => ({ status, body }) });
  return { apiBaseUrl: `${server.origin}${API_PATH}`, requests: server.requests };
}

describe("mapRecording", () => {
  test("maps a name pair onto a MusicBrainz recording", async () => {
    // The exact lookup MusicBrainz's own service would not serve.
    const { apiBaseUrl } = await startMapper(MATCHED);

    const found = await mapRecording(
      { artistName: "Noel Harrison", recordingName: "Windmills of Your Mind" },
      "token",
      { apiBaseUrl },
    );

    expect(found?.recordingMbid).toBe("8e0bed40-e48b-44c1-8fbe-a6194e5cf103");
    expect(found?.artistMbids).toHaveLength(1);
  });

  test("a track the mapper cannot place returns null, not an error", async () => {
    // ListenBrainz signals no match with a body carrying no recording_mbid.
    const { apiBaseUrl } = await startMapper({});

    const found = await mapRecording(
      { artistName: "Nobody", recordingName: "Nothing" },
      "token",
      { apiBaseUrl },
    );

    expect(found).toBeNull();
  });

  test("sends the token as an Authorization header", async () => {
    // Every endpoint here is 401 without it.
    const { apiBaseUrl, requests } = await startMapper(MATCHED);

    await mapRecording({ artistName: "a", recordingName: "b" }, "secret-token", { apiBaseUrl });

    expect(requests[0].headers.authorization).toBe("Token secret-token");
  });

  test("escapes names that would otherwise break the query string", async () => {
    const { apiBaseUrl, requests } = await startMapper(MATCHED);

    await mapRecording(
      { artistName: "AC/DC", recordingName: "Christmas Eve / Sarajevo 12/24" },
      "token",
      { apiBaseUrl },
    );

    expect(requests[0].target).toContain("AC%2FDC");
    expect(requests[0].query.get("artist_name")).toBe("AC/DC");
    expect(requests[0].query.get("recording_name")).toBe("Christmas Eve / Sarajevo 12/24");
  });

  test("a rate-limit refusal is distinguishable from a lookup failure", async () => {
    const { apiBaseUrl } = await startMapper({ error: "rate limited" }, 429);

    await expect(
      mapRecording({ artistName: "a", recordingName: "b" }, "token", { apiBaseUrl }),
    ).rejects.toSatisfy(isListenBrainzRateLimited);
  });

  test("a 500 is not treated as a rate limit", async () => {
    expect(isListenBrainzRateLimited(new ListenBrainzError(500, "boom"))).toBe(false);
  });
});

describe("findRateLimitDelay", () => {
  test("does not wait while budget remains", () => {
    const headers = new Headers({
      "x-ratelimit-remaining": "29",
      "x-ratelimit-reset-in": "9",
    });

    expect(findRateLimitDelay(headers)).toBe(0);
  });

  test("waits for the window to reset when the budget is spent", () => {
    const headers = new Headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset-in": "9",
    });

    expect(findRateLimitDelay(headers)).toBeGreaterThanOrEqual(9_000);
  });

  test("keeps one request in hand rather than spending the last", () => {
    // A concurrent caller — the resolver alarm — could otherwise push the
    // count past zero between the check and the next call.
    const headers = new Headers({
      "x-ratelimit-remaining": "1",
      "x-ratelimit-reset-in": "4",
    });

    expect(findRateLimitDelay(headers)).toBeGreaterThan(0);
  });

  test("missing headers fail safe by waiting rather than assuming budget", () => {
    // A response with no counter says nothing about what remains. Treating
    // that as "plenty left" would spend a budget that may already be gone,
    // so the conservative branch is correct — the assertion expecting zero
    // was wrong, not the code.
    const delay = findRateLimitDelay(new Headers());

    expect(delay).toBeGreaterThan(0);
    expect(Number.isFinite(delay)).toBe(true);
  });
});
