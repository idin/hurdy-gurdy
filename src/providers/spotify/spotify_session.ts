/**
 * Keeping one user's Spotify access token usable across many tool calls.
 *
 * An access token lasts an hour; an MCP session, and the KV entry storing
 * the refresh token, both outlive that easily. So every tool call must be
 * able to discover "is the stored token still good, and if not, refresh it
 * and store the result" — not just read a token once at session start.
 *
 * The refresh token itself is the thing worth keeping durable: it is what
 * KV stores, keyed by Spotify user id. The access token is not stored at
 * all — it is fetched fresh from `refreshAccessToken` whenever a call needs
 * one and doesn't have a still-valid one cached in the (fresh, per-call)
 * closure this module doesn't keep.
 */

import { refreshAccessToken, type SpotifyTokens } from "./spotify_oauth";

const REFRESH_MARGIN_MS = 60_000;

/** What is actually persisted in KV, and its own record of freshness. */
type StoredSession = {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
};

function kvKey(spotifyUserId: string): string {
  return `spotify-session:${spotifyUserId}`;
}

/**
 * Store the tokens from a fresh authorization or refresh.
 *
 * @param kv - The `SPOTIFY_TOKENS` namespace.
 * @param spotifyUserId - Whose session this is.
 * @param tokens - The tokens to store.
 */
export async function storeSession(
  kv: KVNamespace,
  spotifyUserId: string,
  tokens: SpotifyTokens,
): Promise<void> {
  const stored: StoredSession = {
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
  };
  await kv.put(kvKey(spotifyUserId), JSON.stringify(stored));
}

/** Thrown when a caller has no stored session — they need to authorize first. */
export class NoSpotifySessionError extends Error {
  constructor(spotifyUserId: string) {
    super(
      `No stored Spotify session for ${spotifyUserId}. Authorize this server `
        + "with Spotify first.",
    );
    this.name = "NoSpotifySessionError";
  }
}

/**
 * Get a usable access token for a user, refreshing and re-storing it first
 * if the stored one is expired or close to it.
 *
 * @param kv - The `SPOTIFY_TOKENS` namespace.
 * @param spotifyUserId - Whose session to use.
 * @param options.clientId - This app's Spotify client ID, needed to refresh.
 * @param options.now - Clock, injected for testability.
 * @returns A valid access token.
 * @throws NoSpotifySessionError - When the user has never authorized.
 */
export async function getAccessToken(
  kv: KVNamespace,
  spotifyUserId: string,
  options: { clientId: string; now: () => number },
): Promise<string> {
  const raw = await kv.get(kvKey(spotifyUserId));
  if (!raw) {
    throw new NoSpotifySessionError(spotifyUserId);
  }
  const stored = JSON.parse(raw) as StoredSession;

  if (options.now() < stored.expiresAt - REFRESH_MARGIN_MS) {
    return stored.accessToken;
  }

  const refreshed = await refreshAccessToken({
    clientId: options.clientId,
    refreshToken: stored.refreshToken,
    now: options.now,
  });
  await storeSession(kv, spotifyUserId, refreshed);
  return refreshed.accessToken;
}
