import { describe, expect, test, vi } from "vitest";

import { SpotifyProvider } from "../../../src/providers/spotify/spotify_provider";

/**
 * `play` wakes a device when none is active.
 *
 * The cases that matter are the ones where it must *not* retry: an explicit
 * device was asked for, or the failure was something other than
 * NO_ACTIVE_DEVICE. Retrying either would hide a real error behind a second
 * request against a device the caller never chose.
 *
 * Response shapes are copied from what Spotify actually returned for Idin's
 * account on 2026-09-13 — including AVR devices whose `name` is their own id,
 * which is Spotify's doing and not a mapping fault.
 */

const NO_ACTIVE_DEVICE_BODY = JSON.stringify({
  error: { status: 404, message: "Player command failed: No active device found", reason: "NO_ACTIVE_DEVICE" },
});

const DEVICES_BODY = JSON.stringify({
  devices: [
    // Restricted: Spotify says it cannot accept Web API commands, so picking
    // it would trade one error for another.
    { id: "restricted-1", name: "Restricted Speaker", type: "Speaker", is_active: false, is_restricted: true, volume_percent: 50 },
    { id: "device-2", name: "Cleopatra", type: "Computer", is_active: false, is_restricted: false, volume_percent: 100 },
  ],
});

/** Records every request so the test can assert what was actually sent. */
function trackingFetch(responder: (url: string, method: string) => Response) {
  const calls: { url: string; method: string }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    return responder(url, method);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("SpotifyProvider.play device fallback", () => {
  test("retries against a device when nothing is active", async () => {
    let playAttempts = 0;
    const { fetcher, calls } = trackingFetch((url) => {
      if (url.includes("/me/player/devices")) {
        return new Response(DEVICES_BODY, { status: 200 });
      }
      playAttempts += 1;
      // First attempt has no device and fails the way Spotify fails it.
      return playAttempts === 1
        ? new Response(NO_ACTIVE_DEVICE_BODY, { status: 404 })
        : new Response(null, { status: 204 });
    });
    globalThis.fetch = fetcher;

    await new SpotifyProvider("test-token").play({ uri: "spotify:album:album-1" });

    expect(playAttempts).toBe(2);
    const retry = calls[calls.length - 1];
    expect(retry.url).toContain("device_id=device-2");
  });

  test("skips restricted devices when choosing one to wake", async () => {
    // Restricted devices are listed but cannot accept Web API commands.
    const { fetcher, calls } = trackingFetch((url) =>
      url.includes("/me/player/devices")
        ? new Response(DEVICES_BODY, { status: 200 })
        : calls.filter((call) => call.url.includes("/play")).length === 1
          ? new Response(NO_ACTIVE_DEVICE_BODY, { status: 404 })
          : new Response(null, { status: 204 }),
    );
    globalThis.fetch = fetcher;

    await new SpotifyProvider("test-token").play();

    const retry = calls[calls.length - 1];
    expect(retry.url).not.toContain("restricted-1");
    expect(retry.url).toContain("device-2");
  });

  test("does not retry when the caller named a device", async () => {
    // An explicit device that is not active is the caller's problem to see,
    // not something to silently redirect elsewhere.
    let playAttempts = 0;
    const { fetcher } = trackingFetch(() => {
      playAttempts += 1;
      return new Response(NO_ACTIVE_DEVICE_BODY, { status: 404 });
    });
    globalThis.fetch = fetcher;

    await expect(
      new SpotifyProvider("test-token").play({ deviceId: "chosen-device" }),
    ).rejects.toThrow();
    expect(playAttempts).toBe(1);
  });

  test("does not retry on a failure that is not NO_ACTIVE_DEVICE", async () => {
    // The near-miss: 404 from this API also means an ordinary missing
    // resource, and waking a device would not fix that.
    let playAttempts = 0;
    const { fetcher } = trackingFetch(() => {
      playAttempts += 1;
      return new Response(
        JSON.stringify({ error: { status: 404, message: "Not found" } }),
        { status: 404 },
      );
    });
    globalThis.fetch = fetcher;

    await expect(new SpotifyProvider("test-token").play()).rejects.toThrow();
    expect(playAttempts).toBe(1);
  });

  test("reports plainly when no wakeable device exists", async () => {
    const { fetcher } = trackingFetch((url) =>
      url.includes("/me/player/devices")
        ? new Response(JSON.stringify({ devices: [] }), { status: 200 })
        : new Response(NO_ACTIVE_DEVICE_BODY, { status: 404 }),
    );
    globalThis.fetch = fetcher;

    await expect(new SpotifyProvider("test-token").play()).rejects.toThrow(
      /Open Spotify on a phone, computer or speaker/,
    );
  });
});
