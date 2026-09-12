import OAuthProvider from "@cloudflare/workers-oauth-provider";

import { SpotifyHandler } from "./spotify_handler";
import { HurdyGurdyMCP } from "./index";

/**
 * A ready-to-deploy hurdy-gurdy server.
 *
 * Assembled the same way `other-memory`'s `worker.ts` is: the MCP agent,
 * Spotify as the OAuth provider, and the endpoints wired together. Kept
 * separate from `index.ts` for the same reason — importing the library must
 * not also hand you a running worker, so a deployment that needs to change
 * something has somewhere to do it without editing the library's own source.
 */
export default buildWorker(HurdyGurdyMCP);

/**
 * Re-exported by name so `wrangler.jsonc`'s Durable Object binding can find
 * the class. A default export alone is not enough — `other-memory`'s own
 * worker.ts needed this too.
 */
export { HurdyGurdyMCP };

/**
 * Assemble a worker around a `HurdyGurdyMCP` class.
 *
 * @param hurdyGurdyMcp - `HurdyGurdyMCP` or a subclass of it.
 * @returns A worker ready to be a `wrangler.jsonc` `main`.
 */
export function buildWorker(hurdyGurdyMcp: typeof HurdyGurdyMCP) {
  return new OAuthProvider({
    apiHandlers: {
      "/sse": hurdyGurdyMcp.serveSSE("/sse"),
      "/mcp": hurdyGurdyMcp.serve("/mcp"),
    },
    defaultHandler: SpotifyHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
  });
}
