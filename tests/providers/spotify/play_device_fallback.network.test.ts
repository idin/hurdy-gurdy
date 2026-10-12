import { afterEach, describe, expect, test } from "vitest";

import { SpotifyProvider } from "../../../src/providers/spotify/spotify_provider";
import { startLocalSpotifyServer, type LocalSpotifyServer, type RecordedRequest, type ServerReply } from "./local_spotify_server";

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

const NO_ACTIVE_DEVICE_BODY = {
  error: { status: 404, message: "Player command failed: No active device found", reason: "NO_ACTIVE_DEVICE" },
};

const DEVICES_BODY = {
  devices: [
    // Restricted: Spotify says it cannot accept Web API commands, so picking
    // it would trade one error for another.
    { id: "restricted-1", name: "Restricted Speaker", type: "Speaker", is_active: false, is_restricted: true, volume_percent: 50 },
    { id: "device-2", name: "Cleopatra", type: "Computer", is_active: false, is_restricted: false, volume_percent: 100 },
  ],
};

let server: LocalSpotifyServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** Starts a real local server whose replies come from `respond`; requests are recorded on it. */
async function startServer(respond: (request: RecordedRequest) => ServerReply): Promise<LocalSpotifyServer> {
  server = await startLocalSpotifyServer({ respond });
  return server;
}

function newProvider(running: LocalSpotifyServer): SpotifyProvider {
  return new SpotifyProvider("test-token", { apiBaseUrl: running.apiBaseUrl });
}

const isDevicesRequest = (request: RecordedRequest): boolean => request.path === "/me/player/devices";

describe("SpotifyProvider.play device fallback", () => {
  test("retries against a device when nothing is active", async () => {
    let playAttempts = 0;
    const running = await startServer((request) => {
      if (isDevicesRequest(request)) {
        return { status: 200, body: DEVICES_BODY };
      }
      playAttempts += 1;
      // First attempt has no device and fails the way Spotify fails it.
      return playAttempts === 1 ? { status: 404, body: NO_ACTIVE_DEVICE_BODY } : { status: 204 };
    });

    await newProvider(running).play({ uri: "spotify:album:album-1" });

    expect(playAttempts).toBe(2);
    const retry = running.requests[running.requests.length - 1];
    expect(retry.query.get("device_id")).toBe("device-2");
  });

  test("skips restricted devices when choosing one to wake", async () => {
    // Restricted devices are listed but cannot accept Web API commands.
    let playAttempts = 0;
    const running = await startServer((request) => {
      if (isDevicesRequest(request)) {
        return { status: 200, body: DEVICES_BODY };
      }
      playAttempts += 1;
      return playAttempts === 1 ? { status: 404, body: NO_ACTIVE_DEVICE_BODY } : { status: 204 };
    });

    await newProvider(running).play();

    const retry = running.requests[running.requests.length - 1];
    expect(retry.query.get("device_id")).not.toBe("restricted-1");
    expect(retry.query.get("device_id")).toBe("device-2");
  });

  test("does not retry when the caller named a device", async () => {
    // An explicit device that is not active is the caller's problem to see,
    // not something to silently redirect elsewhere.
    const running = await startServer(() => ({ status: 404, body: NO_ACTIVE_DEVICE_BODY }));

    await expect(newProvider(running).play({ deviceId: "chosen-device" })).rejects.toThrow();
    expect(running.requests).toHaveLength(1);
  });

  test("does not retry on a failure that is not NO_ACTIVE_DEVICE", async () => {
    // The near-miss: 404 from this API also means an ordinary missing
    // resource, and waking a device would not fix that.
    const running = await startServer(() => ({
      status: 404,
      body: { error: { status: 404, message: "Not found" } },
    }));

    await expect(newProvider(running).play()).rejects.toThrow();
    expect(running.requests).toHaveLength(1);
  });

  test("reports plainly when no wakeable device exists", async () => {
    const running = await startServer((request) =>
      isDevicesRequest(request)
        ? { status: 200, body: { devices: [] } }
        : { status: 404, body: NO_ACTIVE_DEVICE_BODY },
    );

    await expect(newProvider(running).play()).rejects.toThrow(
      /Open Spotify on a phone, computer or speaker/,
    );
  });
});

describe("SpotifyProvider.play device by name", () => {
  const respondWithDevices = (request: RecordedRequest): ServerReply =>
    isDevicesRequest(request) ? { status: 200, body: DEVICES_BODY } : { status: 204 };

  test("matches a device by type, so \"phone\" finds a Smartphone", async () => {
    const withPhone = {
      devices: [
        { id: "phone-1", name: "Idin's iPhone", type: "Smartphone", is_active: false, is_restricted: false, volume_percent: 70 },
        { id: "device-2", name: "Cleopatra", type: "Computer", is_active: true, is_restricted: false, volume_percent: 100 },
      ],
    };
    const running = await startServer((request) =>
      isDevicesRequest(request) ? { status: 200, body: withPhone } : { status: 204 },
    );

    await newProvider(running).play({ deviceName: "phone" });

    expect(running.requests[running.requests.length - 1].query.get("device_id")).toBe("phone-1");
  });

  test("matches on the device's own name, case-insensitively", async () => {
    const running = await startServer(respondWithDevices);

    await newProvider(running).play({ deviceName: "cleopatra" });

    expect(running.requests[running.requests.length - 1].query.get("device_id")).toBe("device-2");
  });

  test("refuses rather than playing somewhere else when the device is absent", async () => {
    // The bug this fixes: Idin asked for his phone, the phone was not
    // visible to Spotify Connect, and the track played on his computer with
    // nothing said. Understood, ignored, and unmentioned is worse than an
    // error.
    const running = await startServer(respondWithDevices);

    await expect(newProvider(running).play({ deviceName: "phone" })).rejects.toThrow(
      /No Spotify device matching "phone"/,
    );
  });

  test("names what is available when it refuses", async () => {
    const running = await startServer(respondWithDevices);

    await expect(newProvider(running).play({ deviceName: "phone" })).rejects.toThrow(
      /Cleopatra \(Computer\)/,
    );
  });

  test("never plays at all when the named device is missing", async () => {
    // Stronger than the message assertion: no play request may be sent.
    const running = await startServer(respondWithDevices);

    await expect(newProvider(running).play({ deviceName: "kitchen" })).rejects.toThrow();
    expect(running.requests.filter((request) => request.path === "/me/player/play")).toHaveLength(0);
  });
});
