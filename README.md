# music-box

An MCP server giving an agent real Spotify Web API access — full paginated
library, following, and search — instead of the capped, fuzzy first-party
connector.

## Why this exists

The built-in Spotify connector's tools return at most 5 results per search
call, with no pagination, and have no tool at all for listing your full
liked-songs library, followed artists, saved albums, or playlists. Asking
"what bands do I like" cannot be answered completely by a connector that
can only return 5 results.

`music-box` calls the real Spotify Web API directly, with tools that page
through complete lists rather than returning a capped snapshot.

## Architecture

Built on the same pattern as `other-memory`: a Cloudflare Worker running an
MCP agent (`agents/mcp`), with `@cloudflare/workers-oauth-provider` as the
outer OAuth layer between the MCP client and this server, and Spotify as
the identity and data-access provider.

The one structural difference from `other-memory`: GitHub there is used
only to answer "who is this," against a token this server never stores or
reuses. Spotify here is also the source every tool actually calls, so the
tokens from the OAuth exchange are persisted (in `SPOTIFY_TOKENS`, a KV
namespace) and refreshed on every call that needs one — see
`src/providers/spotify/spotify_session.ts`.

`src/providers/media_provider.ts` defines a provider-agnostic interface
(`MediaProvider`) that `src/providers/spotify/` implements. Adding YouTube
Music or Apple Music later is a matter of writing a new file under
`providers/`, not touching the tools or the MCP wiring.

## Tools

- `search_media` — search tracks, artists, albums, playlists (up to 10 per
  type per call, paginated)
- `get_liked_tracks` — the user's full liked-songs library, paginated
- `get_followed_artists` — every artist the user follows, paginated
- `get_saved_albums` — the user's saved albums, paginated
- `get_playlists` — playlists the user owns or follows, paginated
- `get_playlist_tracks` — every track in one playlist, paginated

## Setup

1. Create a Spotify app at https://developer.spotify.com/dashboard to get a
   `Client ID`. This flow uses PKCE, so no client secret is needed.
2. Add `https://<your-worker>.workers.dev/callback` as a Redirect URI on
   the app.
3. `npx wrangler kv namespace create OAUTH_KV` and
   `npx wrangler kv namespace create SPOTIFY_TOKENS`, then copy
   `wrangler.example.jsonc` to `wrangler.jsonc` and fill in the returned
   ids plus your Spotify user id.
4. Set secrets:
   ```sh
   printf %s "$SPOTIFY_CLIENT_ID" | npx wrangler secret put SPOTIFY_CLIENT_ID
   openssl rand -hex 32           | npx wrangler secret put COOKIE_ENCRYPTION_KEY
   ```
5. `npm run deploy`.

## Testing

```sh
npm test              # worker + repository projects
```

No `integration` project yet — those would exercise the real Spotify API
and need a test account and app configured, which this package does not
have set up.
