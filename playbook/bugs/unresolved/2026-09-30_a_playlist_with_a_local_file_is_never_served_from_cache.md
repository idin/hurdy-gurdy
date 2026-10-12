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


## Red against origin/main source, 2026-10-12

```
Green on origin/main, because main validates no cached payload: "is served from cache on the second read" guards the fix (it turns red if a schema rejects a local file's null fields). No red of its own on main.
```


## Red against this pull request's base, 2026-10-12

The regression itself is already prevented by the schema's `id: string | null`
(the "served from cache on the second read" test in `local_files.test.ts`
guards it). What is missing is the mechanism that keeps schema and type the
same truth, whose absence this bug is an instance of:

```
 FAIL  |worker| tests/cache/cached_payload_schemas.test.ts > the drift guard > every schema matches the type it guards
AssertionError: expected undefined to deeply equal { track: true, artist: true, …(6) }
tests/cache/cached_payload_schemas.test.ts(4,8): error TS2305: Module '"../../src/cache/cached_payload_schemas"' has no exported member 'TypeEquality'.
tests/cache/cached_payload_schemas.test.ts(5,3): error TS2305: Module '"../../src/cache/cached_payload_schemas"' has no exported member 'SCHEMAS_MATCH_TYPES'.
```

The four new per-method tests in `caching_and_invalidation.test.ts` (followed
artists, saved albums, playlists, playlist tracks served from cache) pass
already: they guard each method's schema against wrongly refusing valid pages.
