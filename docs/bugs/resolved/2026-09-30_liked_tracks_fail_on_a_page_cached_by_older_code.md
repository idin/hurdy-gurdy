# Liked tracks fail on a page cached by older code

## What was expected

`get_library` with `type: tracks` lists the liked library, from cache or from
Spotify.

## What actually happened

Observed 2026-09-30: the call failed twice, with and without a page size, with

```
D1_TYPE_ERROR: Type 'undefined' not supported
```

while `get_library` for playlists returned all 131 normally.

## Why

The response cache stores provider pages as JSON under a 66-day **sliding**
expiry, so a page that keeps being read never expires, and it outlives
changes to the `Track` type. Two changes have happened since liked-tracks
pages were first cached:

| Date | Commit | Change |
| --- | --- | --- |
| 2026-09-13 | 28d653e | added `isrc` and `albumTrackCount` |
| 2026-09-18 | e19a223 | replaced `durationMs` with `durationSeconds` |

`readThrough` parses a cached page and casts it to `Page<Track>` without
checking it. A page written before 2026-09-18 has no `durationSeconds`, and one
written before 2026-09-13 has no `isrc` either. The missing field is
`undefined`, and `recordTracks` binds it. D1 rejects `undefined` inside
`.bind()` itself, before the batch runs, so the error escapes `runQuietly`'s
catch and fails the tool.

Playlists read fine because the playlist list's shape hasn't changed.

## Evidence

`tests/cache/cached_payload_from_an_older_shape.test.ts` seeds the cache with
the exact shapes those versions stored. Run 2026-09-30:

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  |worker| tests/cache/cached_payload_from_an_older_shape.test.ts > liked tracks cached by older code > a page from before durationSeconds reads without a D1 type error
Error: D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'
 FAIL  |worker| tests/cache/cached_payload_from_an_older_shape.test.ts > liked tracks cached by older code > a page from before ISRC reads without a D1 type error
Error: D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'
 FAIL  |worker| tests/cache/cached_payload_from_an_older_shape.test.ts > liked tracks cached by older code > the same holds when a page size was asked for
Error: D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'
 FAIL  |worker| tests/cache/cached_payload_from_an_older_shape.test.ts > liked tracks cached by older code > the library ends up holding the track, with its real duration
Error: D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'
 Test Files  1 failed (1)
      Tests  4 failed (4)
```

The stack shows where it's thrown:

```
 ❯ D1PreparedStatement.bind cloudflare-internal:d1-api:290:42
 ❯ recordTracks src/cache/record_library_facts.ts:101:10
 ❯ CachedMediaProvider.getLikedTracks src/cache/cached_media_provider.ts:357:11
```

## Proposed fix

The cause is that a cached payload is trusted to match today's types, with
nothing checking it. Filling in the missing fields at the bind site would
treat only this symptom, and it would need redoing on every future type
change.

**Check each cached payload against its type when it's read.** A payload that
doesn't match is treated as a miss: it's refetched and replaced, and the
resulting read is correct.

- Zod schemas for the cached page shapes (`Page<Track>`, `Page<Album>`,
  `Page<Artist>`, `Page<Playlist>`, search results), in a new
  `src/cache/cached_payload_schemas.ts`. Zod is already a dependency.
- `readThrough` takes the schema for its method and runs `safeParse` on the
  cached payload. On a mismatch it falls through to the provider.
- A compile-time check that each schema's `z.infer` equals the TypeScript type
  it guards, so changing `Track` without updating its schema fails
  `npm run typecheck`. This makes the rule mechanical rather than something to
  remember.

After deploy, no manual purge is needed. Every old-shape entry becomes a miss
on its next read, is replaced by a current one, and the old entries age out
under the TTL.

## Fixed and verified — 2026-09-30

Built as proposed:

- `src/cache/cached_payload_schemas.ts` has a zod schema for each cached page
  shape: tracks, artists, albums and playlists.
- `readThrough` runs `safeParse` on every cached payload before serving it.
  One that doesn't match falls through to the provider, and the refetch
  overwrites it.
- `SCHEMAS_MATCH_TYPES` compares each schema's `z.infer` with the type it
  guards, so a type change without a schema change fails `npm run typecheck`.

Playlist *tracks* had the same fault, because they share the `Track` shape, so
they're covered by a fifth regression test. The playlist *list* was fine only
because its shape hasn't changed.

### The guard, shown to discriminate

`tests/cache/cached_payload_schemas.test.ts` covers the pass, the genuine
fails, and the near-miss: an optional `isrc?:` is not the same as a required
nullable `isrc:`. The first version of the guard answered `false` for every
type, including correct ones, because the provider types are intersections
and zod infers a flat object. Both sides are now flattened before comparing.

To check it against a real change, `Track.isrc` was temporarily made
optional:

```
src/cache/cached_payload_schemas.ts(130,7): error TS2322: Type 'true' is not assignable to type 'false'.
src/cache/cached_payload_schemas.ts(130,63): error TS2322: Type 'true' is not assignable to type 'false'.
```

The change was then reverted with `git checkout`.

### Regression tests, now green

```
 ✓ |worker| tests/cache/cached_payload_from_an_older_shape.test.ts > liked tracks cached by older code > a page from before durationSeconds reads without a D1 type error 12ms
 ✓ |worker| tests/cache/cached_payload_from_an_older_shape.test.ts > liked tracks cached by older code > a page from before ISRC reads without a D1 type error 3ms
 ✓ |worker| tests/cache/cached_payload_from_an_older_shape.test.ts > liked tracks cached by older code > the same holds when a page size was asked for 3ms
 ✓ |worker| tests/cache/cached_payload_from_an_older_shape.test.ts > liked tracks cached by older code > the library ends up holding the track, with its real duration 3ms
 ✓ |worker| tests/cache/cached_payload_from_an_older_shape.test.ts > liked tracks cached by older code > playlist tracks cached by older code read too, since they share the shape 3ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Full suite: 350 passed. The only 2 failures are
`tests/cache/artist_coverage.test.ts`, the regression tests for the separate,
still-unresolved artist-coverage bug.
