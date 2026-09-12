import { describe, expect, test, vi } from "vitest";

import {
  getAccessToken,
  NoSpotifySessionError,
  storeSession,
} from "../../../src/providers/spotify/spotify_session";
import type { SpotifyTokens } from "../../../src/providers/spotify/spotify_oauth";

/** A minimal in-memory stand-in for the one KV method pair this module calls. */
function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  } as unknown as KVNamespace;
}

const TOKENS: SpotifyTokens = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 1_000_000,
};

describe("getAccessToken", () => {
  test("throws NoSpotifySessionError when nothing is stored", async () => {
    const kv = fakeKv();
    await expect(
      getAccessToken(kv, "user-1", { clientId: "client", now: () => 0 }),
    ).rejects.toThrow(NoSpotifySessionError);
  });

  test("returns the stored access token when it is still valid", async () => {
    const kv = fakeKv();
    await storeSession(kv, "user-1", TOKENS);

    const token = await getAccessToken(kv, "user-1", {
      clientId: "client",
      now: () => 0,
    });

    expect(token).toBe("access-1");
  });

  test("refreshes and re-stores when the token is within the refresh margin", async () => {
    const kv = fakeKv();
    await storeSession(kv, "user-1", TOKENS);

    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    // 999_500 is inside the 60_000ms margin before TOKENS.expiresAt (1_000_000).
    const token = await getAccessToken(kv, "user-1", {
      clientId: "client",
      now: () => 999_500,
    });

    expect(token).toBe("access-2");

    // The refreshed token must have been written back, or the next call
    // would refresh again unnecessarily on every request.
    const second = await getAccessToken(kv, "user-1", {
      clientId: "client",
      now: () => 999_500,
    });
    expect(second).toBe("access-2");
  });
});
