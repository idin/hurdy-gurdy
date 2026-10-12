import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  getAccessToken,
  getSessionTokens,
  NoSpotifySessionError,
  storeSession,
} from "../../../src/providers/spotify/spotify_session";
import type { SpotifyTokens } from "../../../src/providers/spotify/spotify_oauth";
import { startLocalWorkersStorage, type LocalWorkersStorage } from "../../local_workers_storage";
import { startLocalSpotifyServer, type LocalSpotifyServer } from "./local_spotify_server";

/**
 * KV is Cloudflare's own local implementation (Miniflare), and Spotify's token
 * endpoint is a real local HTTP server. Each test uses its own user id, so the
 * one shared namespace never leaks state between tests.
 */
let storage: LocalWorkersStorage;
let server: LocalSpotifyServer | null = null;
let userCounter = 0;

beforeAll(async () => {
  storage = await startLocalWorkersStorage();
});

afterAll(async () => {
  await storage.dispose();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

function newUserId(): string {
  userCounter += 1;
  return `user-${userCounter}`;
}

/** Starts a server playing Spotify's token endpoint, and returns its URL. */
async function answerRefreshWith(body: Record<string, unknown>): Promise<string> {
  server = await startLocalSpotifyServer({ respond: () => ({ status: 200, body }) });
  return server.tokenUrl;
}

const TOKENS: SpotifyTokens = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 1_000_000,
};

describe("getAccessToken", () => {
  test("throws NoSpotifySessionError when nothing is stored", async () => {
    const kv = storage.kv;
    const userId = newUserId();
    await expect(
      getAccessToken(kv, userId, { clientId: "client", now: () => 0 }),
    ).rejects.toThrow(NoSpotifySessionError);
  });

  test("returns the stored access token when it is still valid", async () => {
    const kv = storage.kv;
    const userId = newUserId();
    await storeSession(kv, userId, TOKENS);

    const token = await getAccessToken(kv, userId, {
      clientId: "client",
      now: () => 0,
    });

    expect(token).toBe("access-1");
  });

  test("refreshes and re-stores when the token is within the refresh margin", async () => {
    const kv = storage.kv;
    const userId = newUserId();
    await storeSession(kv, userId, TOKENS);

    const tokenUrl = await answerRefreshWith({
      access_token: "access-2",
      refresh_token: "refresh-2",
      expires_in: 3600,
    });

    // 999_500 is inside the 60_000ms margin before TOKENS.expiresAt (1_000_000).
    const token = await getAccessToken(kv, userId, {
      clientId: "client",
      now: () => 999_500,
      tokenUrl,
    });

    expect(token).toBe("access-2");

    // The refreshed token must have been written back, or the next call
    // would refresh again unnecessarily on every request.
    const second = await getAccessToken(kv, userId, {
      clientId: "client",
      now: () => 999_500,
      tokenUrl,
    });
    expect(second).toBe("access-2");
    // Written back, so the second call never reached the token endpoint.
    expect(server?.requests).toHaveLength(1);
  });
});

const refreshDue = (tokenUrl: string) => ({ clientId: "client", now: () => 999_500, tokenUrl });
const SCOPES = ["playlist-modify-private", "playlist-modify-public"];

describe("getSessionTokens granted scopes", () => {
  test("returns the scopes stored with the session", async () => {
    const kv = storage.kv;
    const userId = newUserId();
    await storeSession(kv, userId, { ...TOKENS, grantedScopes: SCOPES });

    const session = await getSessionTokens(kv, userId, { clientId: "client", now: () => 0 });

    expect(session).toEqual({ accessToken: "access-1", grantedScopes: SCOPES });
  });

  test("a session stored before scopes were kept loads with null scopes", async () => {
    const kv = storage.kv;
    const userId = newUserId();
    // The exact shape an older version wrote: no grantedScopes field at all.
    await kv.put(
      `spotify-session:${userId}`,
      JSON.stringify({ refreshToken: "refresh-1", accessToken: "access-1", expiresAt: 1_000_000 }),
    );

    const session = await getSessionTokens(kv, userId, { clientId: "client", now: () => 0 });

    expect(session.grantedScopes).toBeNull();
  });

  test("a refresh response without scope keeps the stored scopes, and stores them again", async () => {
    const kv = storage.kv;
    const userId = newUserId();
    await storeSession(kv, userId, { ...TOKENS, grantedScopes: SCOPES });
    const tokenUrl = await answerRefreshWith({ access_token: "access-2", expires_in: 3600 });

    const refreshed = await getSessionTokens(kv, userId, refreshDue(tokenUrl));
    expect(refreshed).toEqual({ accessToken: "access-2", grantedScopes: SCOPES });

    const reloaded = await getSessionTokens(kv, userId, refreshDue(tokenUrl));
    expect(reloaded.grantedScopes).toEqual(SCOPES);
  });

  test("a refresh response with scope replaces the stored scopes", async () => {
    const kv = storage.kv;
    const userId = newUserId();
    await storeSession(kv, userId, { ...TOKENS, grantedScopes: SCOPES });
    const tokenUrl = await answerRefreshWith({ access_token: "access-2", expires_in: 3600, scope: "user-library-read" });

    const refreshed = await getSessionTokens(kv, userId, refreshDue(tokenUrl));

    expect(refreshed.grantedScopes).toEqual(["user-library-read"]);
  });
});
