# A local file stops its whole batch of tracks being recorded

Found while tracing the local-file regression. It was already on `main`.

## What was expected

Every catalogue track on a page is recorded in `track`, whatever else shares
the page.

## What actually happened

An ordinary track on a playlist page that also holds a local file isn't
recorded at all.

## Why

`recordTracks` binds `track.id` into `track.id`, which is `TEXT NOT NULL`. A
local file's id is null, so its insert fails. The inserts run in D1 batches of
up to 50 (`STATEMENTS_PER_BATCH`), and a batch is atomic, so one local file
throws away every other track in its batch. `runQuietly` swallows the error,
so nothing reports it.

## Evidence

Same test file, run 2026-09-30:

```
 FAIL  |worker| tests/cache/cached_media_provider/local_files.test.ts > a playlist holding local files > still records the catalogue track that shares its page
AssertionError: expected null to deeply equal { name: 'Money' }
```

## Proposed fix

The library tables model catalogue tracks, and a local file has no catalogue
identity: no id, no ISRC, and no artist or album ids. So `recordTracks` and
`recordPlaylistTracks` record only tracks that carry an id. They say so in a
comment, and the tool still returns the local file in the page. This fixes
the cause, which is binding a null into a column that can't hold one, instead
of catching the failure afterwards.

## Fixed and verified — 2026-09-30

- `findCatalogueTracks` in `record_library_facts.ts` keeps only tracks with
  an id. `recordTracks` and `recordPlaylistTracks` write only those, so a
  null never reaches the `NOT NULL` column. The local file is still
  returned in the page.

Regression test, now green (2026-09-30):

```
 ✓ |worker| tests/cache/cached_media_provider/local_files.test.ts > a playlist holding local files > still records the catalogue track that shares its page 3ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Full suite: 361 passed. The only 2 failures are
`tests/cache/media_cache_schema/artist_coverage.test.ts`, the regression tests
for the separate, still-unresolved artist-coverage bug.
