# Local-file artists and albums merge into one fake artist and one fake album

Noticed by the independent review of PR #1, and confirmed here. It was
already on `main`.

## What was expected

A local file's artist and album either keep their own identity or aren't
recorded as catalogue entities.

## What actually happened

Every local-file artist is recorded as the single artist
`spotify:artist:null`. Its name is overwritten by whichever local file was
seen last. Every local-file album likewise becomes `spotify:album:null`.

## Why

`toTrack` builds `spotify:artist:${artist.id}` and, when `album.id !== undefined`,
`spotify:album:${album.id}`. Spotify sends those ids as `null` for local files
(documented), which the template turns into the string `"null"`. A null id is
not undefined, so the album guard doesn't catch it either.

## Evidence

Same test file, run 2026-09-30:

```
 FAIL  |worker| tests/cache/cached_media_provider/local_files.test.ts > a playlist holding local files > does not merge two local artists into one fake artist
AssertionError: expected [ Array(1) ] to deeply equal []
 FAIL  |worker| tests/cache/cached_media_provider/local_files.test.ts > a playlist holding local files > does not merge two local albums into one fake album
AssertionError: expected [ { uri: 'spotify:album:null', …(1) } ] to deeply equal []
```

The artist row read `{ name: "Yasunori Mitsuda", uri: "spotify:artist:null" }`,
so David Wise had already been overwritten.

## Proposed fix

Type the ids as `string | null` in `SpotifyTrack`. In `toTrack`:
- `albumUri` is null when the album has no id.
- `Track.artists`, the list of artist identities, holds only artists that
  have an id. `artistNames` keeps every display name, so the credit still
  shows.

The comment claiming the two lists line up by position is corrected, because
for a local file they no longer do.

## Fixed and verified — 2026-09-30

- `toTrack` builds an artist identity only for an artist with an id, and
  sets `albumUri` to null when the album has none. `artistNames` still
  holds every credited name.
- `Track.artistNames`'s comment no longer claims the two lists line up by
  position.

Regression test, now green (2026-09-30):

```
 ✓ |worker| tests/cache/cached_media_provider/local_files.test.ts > a playlist holding local files > does not merge two local artists into one fake artist 3ms
 ✓ |worker| tests/cache/cached_media_provider/local_files.test.ts > a playlist holding local files > does not merge two local albums into one fake album 2ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Full suite: 361 passed. The only 2 failures are
`tests/cache/media_cache_schema/artist_coverage.test.ts`, the regression tests
for the separate, still-unresolved artist-coverage bug.
