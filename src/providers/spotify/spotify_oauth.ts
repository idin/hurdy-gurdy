/**
 * Spotify's Authorization Code with PKCE flow.
 *
 * PKCE, not the plain Authorization Code flow, because this runs in a
 * Cloudflare Worker with no place to keep a client secret safe from a
 * request handler that also serves public endpoints. PKCE proves the token
 * request came from whoever started the authorization request without
 * needing a secret at all — that is the whole point of the extension.
 */

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

/** Scopes this package's tools need, named for what each unlocks. */
export const SPOTIFY_SCOPES = [
  "user-library-read", // liked tracks, saved albums
  "user-follow-read", // followed artists
  "playlist-read-private", // the user's own and followed playlists
  "playlist-read-collaborative",
] as const;

/** A code_verifier: 43-128 characters from Spotify's allowed alphabet. */
const VERIFIER_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const VERIFIER_LENGTH = 64;

/**
 * Generate a PKCE code verifier.
 *
 * @returns A random string in Spotify's allowed alphabet, long enough to
 *   satisfy the 43-character minimum with margin.
 */
export function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(VERIFIER_LENGTH));
  return Array.from(bytes, (byte) => VERIFIER_ALPHABET[byte % VERIFIER_ALPHABET.length]).join(
    "",
  );
}

/**
 * Derive the S256 code challenge from a verifier, base64url-encoded per the
 * PKCE spec (RFC 7636): standard base64, then `+`→`-`, `/`→`_`, padding
 * stripped.
 *
 * @param verifier - The code verifier generated for this authorization.
 * @returns The code challenge to send with the authorization request.
 */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build the URL to send the user to for Spotify's consent screen.
 *
 * @param options.clientId - This app's Spotify client ID.
 * @param options.redirectUri - Must match one registered in the Spotify
 *   dashboard exactly.
 * @param options.codeChallenge - From {@link deriveCodeChallenge}.
 * @param options.state - Opaque value round-tripped to the redirect, for
 *   CSRF protection — the caller generates and verifies it.
 * @returns The full authorize URL to redirect the user to.
 */
export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const url = new URL(SPOTIFY_AUTHORIZE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));
  url.searchParams.set("state", options.state);
  return url.toString();
}

export type SpotifyTokens = {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. Derived from `expires_in` at the moment of the call. */
  expiresAt: number;
};

/**
 * Exchange an authorization code for tokens.
 *
 * @param options.clientId - This app's Spotify client ID.
 * @param options.redirectUri - Must match the one used in the authorize step.
 * @param options.code - The `code` query parameter Spotify redirected back with.
 * @param options.codeVerifier - The verifier generated for this authorization.
 * @param options.now - Clock, injected so `expiresAt` is testable.
 */
export async function exchangeCodeForTokens(options: {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  now: () => number;
}): Promise<SpotifyTokens> {
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: options.clientId,
      code_verifier: options.codeVerifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`Spotify token exchange failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: options.now() + body.expires_in * 1000,
  };
}

/**
 * Refresh an access token.
 *
 * Spotify's PKCE refresh may or may not return a new `refresh_token` — when
 * it does not, the caller keeps using the one it already has. This function
 * reflects that directly: `refreshToken` in the result is the one to store
 * going forward, whether or not Spotify issued a new one.
 *
 * @param options.clientId - This app's Spotify client ID.
 * @param options.refreshToken - The refresh token to use.
 * @param options.now - Clock, injected so `expiresAt` is testable.
 */
export async function refreshAccessToken(options: {
  clientId: string;
  refreshToken: string;
  now: () => number;
}): Promise<SpotifyTokens> {
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
      client_id: options.clientId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Spotify token refresh failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: body.access_token,
    // Spotify's own documented behaviour: a refresh token is not guaranteed
    // in every response, and when absent the existing one is still valid.
    refreshToken: body.refresh_token ?? options.refreshToken,
    expiresAt: options.now() + body.expires_in * 1000,
  };
}

/**
 * Whether a token is due for refresh.
 *
 * @param tokens - The stored tokens.
 * @param options.now - Clock.
 * @param options.marginMs - How long before actual expiry to refresh early,
 *   so a request in flight does not race the token's own expiry.
 */
export function needsRefresh(
  tokens: SpotifyTokens,
  options: { now: () => number; marginMs: number },
): boolean {
  return options.now() >= tokens.expiresAt - options.marginMs;
}
