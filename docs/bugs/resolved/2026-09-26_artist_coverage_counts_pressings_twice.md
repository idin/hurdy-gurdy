# Artist coverage counts pressings of one song as separate songs

## What was expected

An artist's coverage reads "you like N of their M songs", and each song counts
once. Idin's rule, 2026-09-26: "Money" counts once for Pink Floyd whether it
appears on *The Dark Side of the Moon*, its 2011 remaster, the single, or
*Echoes*, for both what is liked (N) and what exists (M).

## What actually happened

**N** — the `artist_coverage` view counts `DISTINCT track.uri`, so every
pressing is its own song. The same song liked on an original and a remaster
counts twice; a collaboration liked twice counts twice for each artist.

**M** — `advanceTrackCount` in `resolve_artist_totals.ts` sums `total_tracks`
over every release the artist has. "Money" contributes once for each album,
remaster, single and compilation it appears on.

## Why the obvious fix is not enough

Switching N to `song_key` does not merge a remaster: `buildSongKey` returns the
ISRC whenever one exists, and a remaster is usually issued under its own ISRC.
That key is right for "same recording", not for "same song".

M cannot be made exact from release totals at all — counting songs means
looking inside each release. Spotify removed batch album lookups
(`GET /albums?ids=`) in February 2026, so that is one `GET /albums/{id}/tracks`
per release, and those simplified tracks carry no ISRC.

## Evidence

`tests/cache/media_cache_schema/artist_coverage.test.ts` (the output below keeps the path it ran under), written through `recordTracks` and
`linkTrackRelations`, run 2026-09-27:

```
 FAIL  |worker| tests/cache/artist_coverage.test.ts > one song, counted once > Money liked on the original and on the 2011 remaster is one song
AssertionError: expected 2 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 2

 ❯ tests/cache/artist_coverage.test.ts:102:50
    100|     ]);
    101|
    102|     expect(await likedSongCount(PINK_FLOYD.uri)).toBe(1);
       |                                                  ^
    103|   });
    104|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  |worker| tests/cache/artist_coverage.test.ts > one song, counted once > a collaboration counts once for each credited artist
AssertionError: expected 2 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 2

 ❯ tests/cache/artist_coverage.test.ts:154:45
    152|     ]);
    153|
    154|     expect(await likedSongCount(QUEEN.uri)).toBe(1);
       |                                             ^
    155|     expect(await likedSongCount(DAVID_BOWIE.uri)).toBe(1);
    156|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

The passing test is the guard against over-merging: the long and short
*Detroit Rock City* must stay two songs, and do.

M has no failing test yet. It needs the release crawl to exist, and is tested
against the real Spotify API in the new `integration` project (see the fix).

## Proposed fix

Count **distinct `title_duration_key` per artist** for both N and M: the
normalised title plus a 5-second duration bucket, from the existing
`buildTitleDurationKey`. The artist is not in the key — the join supplies it —
so two artists' "Windmills of Your Mind" never meet, which was the over-merge
that made the ISRC the default for `song_key`.

- `track.title_duration_key`, computed on write in `recordTracks`; existing
  rows backfilled by `scripts/build_title_duration_key_sql.ts`.
- M from a release crawl: `artist-releases` lists the artist's albums and
  singles into `artist_release`, then `release-tracks` reads each release into
  `release_track` / `release_track_artist`. Both replace the old
  `artist-album-count` and `artist-track-count` kinds.
- The view derives N, M and album counts (distinct `album.work_key`). M stays
  null until every listed release is crawled, because a partial M is a wrong
  number.

This addresses the cause — the wrong unit of identity — rather than the
symptom, and uses one unit on both sides of "N of M".

## Resolution (2026-10-11)

**N is fixed; M is not, and stays open.**

The proposed `title_duration_key` was tried first and failed the collaboration
test: "Under Pressure" at 248.4s and 246.9s round to buckets 50 and 49, so a
bucketed key splits two recordings 1.5s apart. The fix therefore compares
durations by distance, not by bucket:

- `track.normalised_title` (migration, written by `recordTracks`, backfilled
  by `scripts/build_normalised_title_sql.ts`).
- View `artist_liked_song`: one row per artist and song; a liked track is a
  duplicate when the same artist has a liked track with the same normalised
  title within `SAME_SONG_DURATION_TOLERANCE_SECONDS` that sorts before it.
- `artist_coverage.liked_track_count` counts that view. Tracks with no
  duration count as themselves.

Known limit: matching chains (A~B, B~C counts one song even if A and C differ
by more than the tolerance). Existing rows count as separate songs until the
backfill script has been run on them.

Green, run 2026-10-11 (full suite: 33 files, 336 tests passed):

```
 RUN  v4.1.11 /Users/idin/code/hurdy-gurdy
 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  19:31:41
   Duration  275ms (transform 22ms, setup 0ms, import 42ms, tests 16ms, environment 1ms)
```

**M (total songs) remains open.** It needs the release crawl (`GET
/albums/{id}/tracks` per release, new tables and resolver kinds), which is a
separate piece of work; `advanceTrackCount` still sums `total_tracks`, so
"N of M" mixes songs with pressings on the M side until then.
