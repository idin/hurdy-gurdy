import { afterEach, describe, expect, test, vi } from "vitest";

import {
  getAccessToken,
  getSessionTokens,
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

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Stands in for Spotify's token endpoint only. */
function answerRefreshWith(body: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  ) as unknown as typeof fetch;
}

const SCOPES = ["playlist-modify-private", "playlist-modify-public"];

describe("getSessionTokens granted scopes", () => {
  test("returns the scopes stored with the session", async () => {
    const kv = fakeKv();
    await storeSession(kv, "user-1", { ...TOKENS, grantedScopes: SCOPES });

    const session = await getSessionTokens(kv, "user-1", { clientId: "client", now: () => 0 });

    expect(session).toEqual({ accessToken: "access-1", grantedScopes: SCOPES });
  });

  test("a session stored before scopes were kept loads with null scopes", async () => {
    const kv = fakeKv();
    // The exact shape an older version wrote: no grantedScopes field at all.
    await kv.put(
      "spotify-session:user-1",
      JSON.stringify({ refreshToken: "refresh-1", accessToken: "access-1", expiresAt: 1_000_000 }),
    );

    const session = await getSessionTokens(kv, "user-1", { clientId: "client", now: () => 0 });

    expect(session.grantedScopes).toBeNull();
  });

  test("a refresh response without scope keeps the stored scopes, and stores them again", async () => {
    const kv = fakeKv();
    await storeSession(kv, "user-1", { ...TOKENS, grantedScopes: SCOPES });
    answerRefreshWith({ access_token: "access-2", expires_in: 3600 });

    const refreshed = await getSessionTokens(kv, "user-1", {
      clientId: "client",
      now: () => 999_500,
    });
    expect(refreshed).toEqual({ accessToken: "access-2", grantedScopes: SCOPES });

    const reloaded = await getSessionTokens(kv, "user-1", { clientId: "client", now: () => 999_500 });
    expect(reloaded.grantedScopes).toEqual(SCOPES);
  });

  test("a refresh response with scope replaces the stored scopes", async () => {
    const kv = fakeKv();
    await storeSession(kv, "user-1", { ...TOKENS, grantedScopes: SCOPES });
    answerRefreshWith({ access_token: "access-2", expires_in: 3600, scope: "user-library-read" });

    const refreshed = await getSessionTokens(kv, "user-1", {
      clientId: "client",
      now: () => 999_500,
    });

    expect(refreshed.grantedScopes).toEqual(["user-library-read"]);
  });
});
