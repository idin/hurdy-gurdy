# artist_liked_song merges same-title tracks whose duration is the placeholder 0

## What was expected

Tracks with no known duration count as themselves (the view comment says so),
so two same-title liked tracks without a duration are two songs.

## What happened

`recordTracks` stores `0` as the placeholder duration for export rows that
have none. The view `artist_liked_song` only excludes NULL durations, so
`ABS(0 - 0) <= 5` holds and two such tracks of one artist merge into one song.
Found by the tester while covering the null case, 2026-10-11.

## Scenario

Two liked tracks named "Money" by one artist, both `duration_seconds = 0`:
`artist_coverage.liked_track_count` is 1, expected 2.

## Red, then green (2026-10-11)

Red (tests/cache/media_cache_schema/artist_coverage_edges.test.ts, commit ede5bd9):
`AssertionError: expected 1 to be 2` at line 115.

Fix: the view compares only durations greater than 0 (0 is the unknown placeholder).
Green: full suite 35 files, 347 tests passed; `npx tsc --noEmit` clean.
