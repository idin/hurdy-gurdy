/**
 * Spotify as the identity and data-access provider for this MCP server's
 * own OAuth layer.
 *
 * Shaped after `other-memory`'s `github_handler.ts`, with one structural
 * difference: GitHub there is only ever used to answer "who is this,"
 * against a token this server never stores or reuses. Spotify here is also
 * the source the tools actually call — the tokens from this exchange are
 * what `spotify_session.ts` persists and refreshes for every later tool
 * call, not a one-time identity check.
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";

import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  exchangeCodeForTokens,
  generateCodeVerifier,
} from "./providers/spotify/spotify_oauth";
import { storeSession } from "./providers/spotify/spotify_session";
import type { Env, UserProps } from "./types";

/**
 * Only this Spotify account may complete the flow. Single-user by design —
 * an authenticated stranger is still a stranger.
 */
function assertAllowedUser(spotifyUserId: string, env: Env): void {
  if (spotifyUserId !== env.ALLOWED_SPOTIFY_USER_ID) {
    throw new Error(`Spotify user ${spotifyUserId} is not permitted to use this server.`);
  }
}

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (context) => {
  const oauthRequest = await context.env.OAUTH_PROVIDER.parseAuthRequest(context.req.raw);
  if (!oauthRequest.clientId) {
    return context.text("Invalid authorization request.", 400);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await deriveCodeChallenge(codeVerifier);

  // The verifier has to survive the round trip to Spotify and back, and
  // this server keeps no server-side session between the two requests — so
  // it travels inside `state`, alongside the original MCP AuthRequest, the
  // same way `oauthRequest` itself does in the GitHub handler.
  const state = btoa(JSON.stringify({ oauthRequest, codeVerifier }));

  const redirectUri = new URL("/callback", context.req.url).href;
  const authorizeUrl = buildAuthorizeUrl({
    clientId: context.env.SPOTIFY_CLIENT_ID,
    redirectUri,
    codeChallenge,
    state,
  });

  return Response.redirect(authorizeUrl, 302);
});

app.get("/callback", async (context) => {
  const code = context.req.query("code");
  const stateParam = context.req.query("state");
  if (!code || !stateParam) {
    return context.text("Missing code or state.", 400);
  }

  let oauthRequest: AuthRequest;
  let codeVerifier: string;
  try {
    ({ oauthRequest, codeVerifier } = JSON.parse(atob(stateParam)) as {
      oauthRequest: AuthRequest;
      codeVerifier: string;
    });
  } catch {
    return context.text("Invalid state.", 400);
  }

  const redirectUri = new URL("/callback", context.req.url).href;
  const tokens = await exchangeCodeForTokens({
    clientId: context.env.SPOTIFY_CLIENT_ID,
    redirectUri,
    code,
    codeVerifier,
    now: () => Date.now(),
  });

  const profile = await fetchSpotifyProfile(tokens.accessToken);

  try {
    assertAllowedUser(profile.id, context.env);
  } catch (error) {
    return context.text((error as Error).message, 403);
  }

  await storeSession(context.env.SPOTIFY_TOKENS, profile.id, tokens);

  const props: UserProps = {
    spotifyUserId: profile.id,
    displayName: profile.display_name ?? profile.id,
  };

  const { redirectTo } = await context.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: profile.id,
    metadata: { label: props.displayName },
    scope: oauthRequest.scope,
    props,
  });

  return Response.redirect(redirectTo, 302);
});

async function fetchSpotifyProfile(
  accessToken: string,
): Promise<{ id: string; display_name: string | null }> {
  const response = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Fetching the Spotify profile failed: ${response.status}`);
  }
  return response.json();
}

export { app as SpotifyHandler };
