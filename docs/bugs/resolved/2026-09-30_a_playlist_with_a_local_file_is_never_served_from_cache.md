# A playlist holding a local file is never served from cache

Found by the independent review of PR #1, and confirmed here. It is a
regression introduced by that PR, which is already deployed.

## What was expected

A second read of a playlist's tracks is served from the response cache,
without a Spotify request.

## What actually happened

Every read goes back to Spotify when the page holds a local file. Each one
charges the fetch budget, and the cache never heals itself.

## Why

Spotify describes a local file with `"id": null` (Playlists concept page,
developer.spotify.com/documentation/web-api/concepts/playlists, read
2026-09-30). `SpotifyTrack.id` and `Track.id` are typed `string`, so the mapper
passes that null through under a type that says it can't happen.

PR #1's `TRACK_SCHEMA` requires `id: z.string()`. It rejects the page, so the
read falls through to Spotify, and the refetch stores the same rejected
payload again. The schema is right about the declared type. The declared type
is wrong about Spotify.

## Evidence

`tests/cache/cached_media_provider/local_files.test.ts` feeds Spotify's
documented local-file JSON through `SpotifyProvider` and `CachedMediaProvider`
into a real D1. Run 2026-09-30:

```
 FAIL  |worker| tests/cache/cached_media_provider/local_files.test.ts > a playlist holding local files > is served from cache on the second read
AssertionError: expected 2 to be 1 // Object.is equality
```

## Proposed fix

Type local files honestly rather than loosening the check:
`SpotifyTrack.id`, `Track.id` and `TRACK_SCHEMA.id` become `string | null`.
The drift guard then holds the schema and the type to the same truth.

## Fixed and verified — 2026-09-30

- `SpotifyTrack.id`, `Track.id` and `TRACK_SCHEMA.id` are now `string | null`.
  The drift guard holds the schema and the type to the same truth.
- A rejected cached payload is now logged (`cached_payload_rejected`, with
  its key and the failing field), so a schema that keeps refusing one key
  is visible instead of quietly disabling the cache.

Regression test, now green (2026-09-30):

```
 ✓ |worker| tests/cache/cached_media_provider/local_files.test.ts > a playlist holding local files > is served from cache on the second read 13ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Full suite: 361 passed. The only 2 failures are
`tests/cache/media_cache_schema/artist_coverage.test.ts`, the regression tests
for the separate, still-unresolved artist-coverage bug.
