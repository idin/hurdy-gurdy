# create_playlist returns 403 because it calls an endpoint Spotify removed

## What was expected

`create_playlist` with name "The Beautifully Macabre | Halloween After Dark"
creates the playlist, with `public: false` and with `public` omitted.

## What happened

On 2026-10-11 both calls returned:

```
Spotify API returned 403: {"error": {"status": 403, "message": "Forbidden"}}
```

Reads (`search_media`, `get_library`, `get_playlist_tracks`, `get_usage`) work
with the same authorisation. Only the write is refused. The error says
nothing about which request failed or which scopes the token holds.

## Trigger

Call `create_playlist` with any name.

## Root cause

`SpotifyApiClient.createPlaylist` (`src/providers/spotify/spotify_api_client.ts:430`)
sends `POST /v1/users/{user_id}/playlists`. Spotify's February 2026 changelog
(https://developer.spotify.com/documentation/web-api/references/changes/february-2026,
read 2026-10-11) lists it as `[REMOVED] Create Playlist for user
(POST /users/{user_id}/playlists)` with "Use `POST /me/playlists` instead";
`POST /me/playlists` is the surviving "Create Playlist ... for logged in users".

Candidates ruled out from the source:

- Scopes: `SPOTIFY_SCOPES` (`spotify_oauth.ts:22`) already requests
  `playlist-modify-private` and `playlist-modify-public`, and
  `buildAuthorizeUrl` sends them all. A session authorised before they were
  added would also 403, but this cannot be told apart today because granted
  scopes are never stored or logged (`SpotifyTokens` has no scope field). The
  builder's logging change makes that checkable. If the new endpoint still
  returns 403, the user must reconnect to re-consent.
- Dev-mode restrictions: the changelog page does not document any for playlist
  creation (not checked beyond that page).
- Not confirmed against the live API: the changelog does not state which status
  a removed endpoint returns; a 403 matches the other removed endpoints noted
  in `spotify_api_client.ts` (`/me/tracks/contains`).

## Fix required (for the builder)

1. `createPlaylist` posts to `/me/playlists` with the same body; the
   `getCurrentUser()` call in `SpotifyProvider.createPlaylist` is then unneeded.
2. A failed write's error names the method, the path and the granted scopes.
   Tests assume `new SpotifyProvider(accessToken, { grantedScopes })` and that
   the session stores the `scope` of Spotify's token response; the builder may
   change that constructor shape and the test with the tester.

## Regression tests

`tests/providers/spotify/create_playlist_endpoint.test.ts` (fake network edge
that refuses the removed path with 403 and accepts `/me/playlists`; provider
and client are real).

Red output before the fix (not the wrong colour: the first two reproduce the
exact reported 403 from `createPlaylist`, the third shows the bare message):

```
 × creates a private playlist through POST /me/playlists, not the removed /users/{id}/playlists
 × creates a playlist when public is omitted
 × the error carries the method, the path and the granted scopes

SpotifyApiError: Spotify API returned 403: {"error":{"status":403,"message":"Forbidden"}}
 ❯ SpotifyProvider.createPlaylist src/providers/spotify/spotify_provider.ts:271:21
AssertionError: expected 'Spotify API returned 403: {"error":{"…' to contain 'PUT'
 Tests  3 failed (3)
```

## Fix (2026-10-11)

- `SpotifyApiClient.createPlaylist` posts to `/me/playlists` with the same
  body; `SpotifyProvider.createPlaylist` no longer calls `getCurrentUser()`
  (the method is removed, nothing else used it).
- The token response's `scope` is stored in the session (`grantedScopes`);
  sessions stored before this read as unknown. `getSessionTokens` returns it,
  `SpotifyProvider` takes `{ grantedScopes }`, and every refused write's
  `SpotifyApiError` message ends `(METHOD /path; granted scopes: ...)`, with
  "unknown" when none is stored.
- Other playlist endpoints checked against the February 2026 changelog
  (read 2026-10-11): add items (`POST /playlists/{id}/items`), remove items
  (`DELETE .../items`) and change details (`PUT /playlists/{id}`) are on
  surviving paths. Remove items' request body field is `items`, not `tracks`
  (Spotify's remove-items reference, read 2026-10-11); the client sent
  `tracks`, so it is changed to `items`. No test covers that body yet.

Green output after the fix:

```
 Test Files  6 passed (6)   (tests/providers)
      Tests  45 passed (45)
```

including the three regression tests in
`tests/providers/spotify/create_playlist_endpoint.test.ts`. Whole suite: 76
failures remain, all identical before the fix (`database` undefined in
`prepareMediaCache`: no D1 binding in this worktree; 6 unrelated type errors
in `tests/resolver/musicbrainz_resolution_routing.test.ts` and
`tests/cache/views_survive_preparation.test.ts`). Before the fix: 79 failures.

Correction (review round 1): the entry above said `getCurrentUser()` was
removed; it was still defined, unused. It is now actually removed from
`SpotifyApiClient`. The remove-items body change (`tracks` to `items`) was
checked against https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist
on 2026-10-11.
