import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  exchangeCodeForTokens,
  generateCodeVerifier,
  needsRefresh,
  refreshAccessToken,
  SPOTIFY_SCOPES,
} from "../../../src/providers/spotify/spotify_oauth";

describe("deriveCodeChallenge", () => {
  test("matches RFC 7636 Appendix B's worked example", async () => {
    // The RFC's own test vector, not a value this code produced itself —
    // a self-referential test proves only that the function is consistent
    // with itself, not that it implements the spec correctly.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    expect(await deriveCodeChallenge(verifier)).toBe(expectedChallenge);
  });

  test("contains no base64 padding or URL-unsafe characters", async () => {
    const challenge = await deriveCodeChallenge(generateCodeVerifier());
    expect(challenge).not.toMatch(/[+/=]/);
  });
});

describe("generateCodeVerifier", () => {
  test("is within RFC 7636's 43-128 character range", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  test("uses only the RFC's allowed alphabet", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test("two calls produce different verifiers", () => {
    // Not a proof of cryptographic quality, just a guard against an
    // accidentally deterministic implementation.
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });
});

describe("buildAuthorizeUrl", () => {
  test("includes every required PKCE and OAuth parameter", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client-123",
        redirectUri: "https://example.workers.dev/callback",
        codeChallenge: "challenge-abc",
        state: "state-xyz",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.workers.dev/callback",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("state")).toBe("state-xyz");
  });

  test("requests exactly the scopes this package needs, space-separated", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client-123",
        redirectUri: "https://example.workers.dev/callback",
        codeChallenge: "challenge-abc",
        state: "state-xyz",
      }),
    );
    expect(url.searchParams.get("scope")).toBe(SPOTIFY_SCOPES.join(" "));
  });
});

describe("needsRefresh", () => {
  const tokens = {
    accessToken: "a",
    refreshToken: "r",
    expiresAt: 1_000_000,
  };

  test("false well before expiry", () => {
    expect(
      needsRefresh(tokens, { now: () => 0, marginMilliseconds: 60_000 }),
    ).toBe(false);
  });

  test("true once inside the refresh margin", () => {
    expect(
      needsRefresh(tokens, { now: () => 999_500, marginMilliseconds: 60_000 }),
    ).toBe(true);
  });

  test("true once already past expiry", () => {
    expect(
      needsRefresh(tokens, { now: () => 1_000_001, marginMilliseconds: 60_000 }),
    ).toBe(true);
  });
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Stands in for Spotify's token endpoint only; the OAuth code above it is real. */
function answerTokenRequestWith(body: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  ) as unknown as typeof fetch;
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
    answerTokenRequestWith({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
      scope: "playlist-modify-private playlist-modify-public",
    });

    const tokens = await exchangeCodeForTokens(EXCHANGE_PARAMETERS);

    expect(tokens.grantedScopes).toEqual(["playlist-modify-private", "playlist-modify-public"]);
  });

  test("exchangeCodeForTokens reports unknown scopes as null when the response has no scope", async () => {
    answerTokenRequestWith({ access_token: "a", refresh_token: "r", expires_in: 3600 });

    const tokens = await exchangeCodeForTokens(EXCHANGE_PARAMETERS);

    expect(tokens.grantedScopes).toBeNull();
  });

  test("refreshAccessToken returns the scopes from the refresh response", async () => {
    answerTokenRequestWith({ access_token: "a2", expires_in: 3600, scope: "user-library-read" });

    const tokens = await refreshAccessToken({
      clientId: "client",
      refreshToken: "r",
      now: () => 0,
    });

    expect(tokens.grantedScopes).toEqual(["user-library-read"]);
  });
});
