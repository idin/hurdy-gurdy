# `get_playlists` crashes when Spotify omits the tracks summary

## What was expected

`get_playlists` returns a page of the user's playlists, each carrying a
`trackCount`.

## What actually happened

Every call fails, with and without a limit:

```
Cannot read properties of undefined (reading 'total')
```

Reported by an agent using the deployed server on 2026-09-13, on the first
real use of Hurdy Gurdy after the OAuth flow was connected.

## The scenario that triggers it

`GET /v1/me/playlists` returns `200` with a well-formed paging object — but
**every item has `tracks: null`**. Verified against the live API with Idin's
own session on 2026-09-13: 131 playlists total, 50 returned in the first
page, all 50 with `tracks` null, none with a null `owner`, no null items.

`toPlaylist` in `src/providers/spotify/spotify_provider.ts` reads:

```ts
trackCount: playlist.tracks.total,
```

With `tracks` null, that throws before `offsetPage` ever runs.

This is almost certainly part of Spotify's February 2026 API changes, the
same round that moved `/playlists/{id}/tracks` to `/items` and renamed the
`track` field to `item`. The `tracks` summary object on the *list* endpoint
appears to have been dropped; the endpoint still documents it, so this was
found by observation rather than from the docs.

## Two wrong diagnoses, recorded because they were plausible

The reporting agent proposed two causes, both wrong, both checkable:

1. **"A missing `playlist-read-private` / `playlist-read-collaborative`
   scope."** Both scopes are in `SPOTIFY_SCOPES`
   (`src/providers/spotify/spotify_oauth.ts:15-20`), and the live call
   returns `200`, not `403`.
2. **"The handler does not check `res.ok` before reading the body."** It
   does — `src/providers/spotify/spotify_api_client.ts:121` throws a
   `SpotifyApiError` on any non-OK response.

Both were inferences from the error message rather than reads of the code
or the API. The actual cause was found by calling the endpoint and looking
at what came back.

## Why no test caught it

`tests/providers/spotify/spotify_provider.test.ts` builds its playlist
fixture with a populated `tracks: { total: n }`, because that is what the
documentation says the endpoint returns. The fixture encoded the
documented shape rather than the observed one.

## Proposed fix

Treat the tracks summary as optional, because it now is:

- Type `SpotifyPlaylist["tracks"]` as `{ total: number } | null`.
- In `toPlaylist`, return `trackCount: playlist.tracks?.total ?? null`, and
  widen `Playlist["trackCount"]` to `number | null`.

`null` rather than `0`: a playlist whose count is unknown is not a playlist
with no tracks, and returning `0` would be inventing a fact. A caller that
needs the real count can call `get_playlist_tracks`, which pages the items
and is unaffected.

Same guard applies to `owner`, which is populated today but is the same
class of nested object and costs nothing to protect.

## Regression test

Added to `tests/providers/spotify/spotify_provider.test.ts`: a playlist
fixture with `tracks: null`, asserting the page is returned with
`trackCount: null` rather than throwing.

## Verified — 2026-09-13

### Before the fix

```
FAIL  tests/.../spotify_provider.test.ts > SpotifyProvider.getPlaylists > survives Spotify omitting the tracks summary
TypeError: Cannot read properties of null (reading 'total')
 ❯ toPlaylist src/providers/spotify/spotify_provider.ts:61:33
     60|     ownerName: playlist.owner.display_name ?? playlist.owner.id,
     61|     trackCount: playlist.tracks.total,
       |                                 ^
Failed Tests 3
```

The fourth test — a playlist that *does* carry a count — passed before the
fix, confirming the near-miss case worked and had to keep working.

### After the fix

```
Test Files  6 passed (6)
     Tests  47 passed (47)
```

Typecheck clean. Deployed to hurdy-gurdy.idin-cf5.workers.dev,
version 5da78113-4b01-4c48-989d-d7e95e862193.

### What shipped

- `SpotifyPlaylist["tracks"]` typed `{ total: number } | null`, with the
  observation and its date recorded on the type itself.
- `Playlist["trackCount"]` widened to `number | null`.
- `toPlaylist` reads both `tracks` and `owner` defensively. `owner` was not
  failing, but is the same class of nested object from the same endpoint.
- Four tests, from the live response shape rather than the documentation.

### The lesson worth keeping

The fixture was written from Spotify's published example, so it encoded the
documented shape rather than the observed one and passed while production
threw. `getPlaylistTracks` had the same gap and was caught the same way.

**When a provider's docs and its live response disagree, the live response
is the fact.** A fixture copied from documentation tests the documentation.
