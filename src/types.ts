export type Env = {
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  SPOTIFY_CLIENT_ID: string;
  COOKIE_ENCRYPTION_KEY: string;
  /**
   * Where the media cache lives. Optional: a deployment without a D1
   * database gets an uncached but fully working server.
   */
  MEDIA_CACHE?: D1Database;
  /**
   * Stores each user's Spotify refresh token, keyed by their Spotify user
   * id. Separate from OAUTH_KV, which belongs to the outer MCP OAuth layer
   * (`@cloudflare/workers-oauth-provider`) and is never touched by this
   * server's own code directly — Spotify tokens are a different concern
   * with a different lifetime (they refresh hourly; the MCP session token
   * does not).
   */
  SPOTIFY_TOKENS: KVNamespace;
  /** The single Spotify account permitted to authenticate. */
  ALLOWED_SPOTIFY_USER_ID: string;
};

/**
 * Identity of the authenticated caller, carried through to the MCP agent.
 *
 * Deliberately does not carry the Spotify access token itself — access
 * tokens expire in an hour and `props` is fixed for the life of the
 * session, so a long session would silently start failing once the token
 * aged out. Tools look the current, possibly-refreshed token up from
 * `SPOTIFY_TOKENS` by `spotifyUserId` on every call instead. See
 * `spotify_session.ts`.
 */
export type UserProps = {
  spotifyUserId: string;
  displayName: string;
};
