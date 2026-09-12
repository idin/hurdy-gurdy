import OAuthProvider from "@cloudflare/workers-oauth-provider";

import { SpotifyHandler } from "./spotify_handler";
import { MusixBoxMCP } from "./index";

/**
 * A ready-to-deploy musix-box server.
 *
 * Assembled the same way `other-memory`'s `worker.ts` is: the MCP agent,
 * Spotify as the OAuth provider, and the endpoints wired together. Kept
 * separate from `index.ts` for the same reason — importing the library must
 * not also hand you a running worker, so a deployment that needs to change
 * something has somewhere to do it without editing the library's own source.
 */
export default buildWorker(MusixBoxMCP);

/**
 * Assemble a worker around a `MusixBoxMCP` class.
 *
 * @param musixBoxMcp - `MusixBoxMCP` or a subclass of it.
 * @returns A worker ready to be a `wrangler.jsonc` `main`.
 */
export function buildWorker(musixBoxMcp: typeof MusixBoxMCP) {
  return new OAuthProvider({
    apiHandlers: {
      "/sse": musixBoxMcp.serveSSE("/sse"),
      "/mcp": musixBoxMcp.serve("/mcp"),
    },
    defaultHandler: SpotifyHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
  });
}
