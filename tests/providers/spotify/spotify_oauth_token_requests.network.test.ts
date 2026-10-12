import { afterEach, describe, expect, test } from "vitest";

import { exchangeCodeForTokens, refreshAccessToken } from "../../../src/providers/spotify/spotify_oauth";
import { startLocalSpotifyServer, type LocalSpotifyServer } from "./local_spotify_server";

/** A real local server plays Spotify's token endpoint; the OAuth code above it is real. */
let server: LocalSpotifyServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function startTokenEndpointAnswering(body: Record<string, unknown>): Promise<LocalSpotifyServer> {
  server = await startLocalSpotifyServer({ respond: () => ({ status: 200, body }) });
  return server;
}

const EXCHANGE_PARAMETERS = {
  clientId: "client",
  redirectUri: "https://example.workers.dev/callback",
  code: "code",
  codeVerifier: "verifier",
  now: () => 0,
};

describe("granted scopes in token responses", () => {
  test("exchangeCodeForTokens returns the scopes Spotify granted", async () => {
    const running = await startTokenEndpointAnswering({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
      scope: "playlist-modify-private playlist-modify-public",
    });

    const tokens = await exchangeCodeForTokens({ ...EXCHANGE_PARAMETERS, tokenUrl: running.tokenUrl });

    expect(tokens.grantedScopes).toEqual(["playlist-modify-private", "playlist-modify-public"]);
  });

  test("exchangeCodeForTokens reports unknown scopes as null when the response has no scope", async () => {
    const running = await startTokenEndpointAnswering({ access_token: "a", refresh_token: "r", expires_in: 3600 });

    const tokens = await exchangeCodeForTokens({ ...EXCHANGE_PARAMETERS, tokenUrl: running.tokenUrl });

    expect(tokens.grantedScopes).toBeNull();
  });

  test("refreshAccessToken returns the scopes from the refresh response", async () => {
    const running = await startTokenEndpointAnswering({
      access_token: "a2",
      expires_in: 3600,
      scope: "user-library-read",
    });

    const tokens = await refreshAccessToken({
      clientId: "client",
      refreshToken: "r",
      now: () => 0,
      tokenUrl: running.tokenUrl,
    });

    expect(tokens.grantedScopes).toEqual(["user-library-read"]);
  });

  test("the token request carries the grant type and the refresh token as a form", async () => {
    const running = await startTokenEndpointAnswering({ access_token: "a2", expires_in: 3600 });

    await refreshAccessToken({ clientId: "client", refreshToken: "r", now: () => 0, tokenUrl: running.tokenUrl });

    const form = new URLSearchParams(running.requests[0].body as string);
    expect(running.requests[0].method).toBe("POST");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("r");
  });
});
