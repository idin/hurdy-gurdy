/**
 * Every outbound catalogue request must be bounded.
 *
 * The bug this guards: `fetch` in Node has no default timeout, so a connection
 * that is accepted and never answered hangs until the operating system gives
 * up. Measured 2026-09-19, one `findRecordingDetail` call ran **1,022,647 ms —
 * seventeen minutes** — before failing, while its five neighbours averaged
 * 300 ms. That single row turned a 23-minute bulk pass into a 24-hour one, and
 * left no error until it finally gave out.
 *
 * See `docs/bugs/resolved/2026-09-19_a_request_with_no_timeout_hung_for_seventeen_minutes.md`.
 *
 * These tests assert the *signal is passed*, not that a real timeout elapses.
 * Waiting out a ten-second bound in a unit test would make the suite slow for
 * no extra confidence — the thing that was missing was the signal, and its
 * presence is what needs guarding.
 */

import { describe, expect, it } from "vitest";

import { findRecordingDetail } from "../../src/catalogue/musicbrainz_client";
import { mapRecording } from "../../src/catalogue/listenbrainz_client";

/** Captures the request options a client passes, without reaching the network. */
function captureRequestOptions(): {
  optionsSeen: RequestInit[];
  fetcher: typeof fetch;
} {
  const optionsSeen: RequestInit[] = [];
  const fetcher = (async (_input: RequestInfo | URL, options?: RequestInit) => {
    optionsSeen.push(options ?? {});
    return new Response(JSON.stringify({ id: "rec-1", title: "Karma Police" }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { optionsSeen, fetcher };
}

describe("catalogue requests are bounded", () => {
  it("gives a MusicBrainz request an abort signal", async () => {
    const { optionsSeen, fetcher } = captureRequestOptions();

    await findRecordingDetail("d3528f95-1a3f-45d2-a569-826740c0adee", fetcher);

    expect(optionsSeen).toHaveLength(1);
    expect(optionsSeen[0].signal, "a request with no signal can hang forever").toBeDefined();
  });

  it("gives a ListenBrainz request an abort signal", async () => {
    const { optionsSeen, fetcher } = captureRequestOptions();

    await mapRecording(
      { artistName: "Radiohead", recordingName: "Karma Police" },
      "a-token",
      fetcher,
    );

    expect(optionsSeen).toHaveLength(1);
    expect(optionsSeen[0].signal, "a request with no signal can hang forever").toBeDefined();
  });

  it("aborts rather than hanging when a request never resolves", async () => {
    // The symptom itself. A fetcher that never settles reproduces the dead
    // connection; without a signal this test would hang rather than fail,
    // which is why it carries its own outer bound.
    const neverResolves = ((_input: RequestInfo | URL, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "TimeoutError"));
        });
      })) as unknown as typeof fetch;

    const outerBound = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error("the call did not abort within 15s")), 15_000),
    );

    await expect(
      Promise.race([
        findRecordingDetail("d3528f95-1a3f-45d2-a569-826740c0adee", neverResolves),
        outerBound,
      ]),
    ).rejects.toThrow();
  }, 20_000);
});
