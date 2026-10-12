# Album versions, works, and consolidating likes

Decided 2026-09-13, from Idin's rulings. Nothing here is built yet.

## The problem, in real numbers

Pink Floyd's first 24 releases on Spotify contain three exact duplicate
pairs — same album, same track count, different master:

| Original | Reissue | Tracks |
| --- | --- | --- |
| Animals (1977) | Animals (2018 Remix) | 5 / 5 |
| A Momentary Lapse of Reason (1987) | (2019 Remix) | 11 / 11 |
| The Dark Side of the Moon (1973) | (50th Anniversary) [2023 Remastered] | 10 / 10 |

That is ~12% denominator inflation for one artist, and worse across a full
discography. It also splits the numerator: a like on *Animals* track 3 and a
like on *Animals (2018 Remix)* track 7 read today as **one liked track from
each of two albums**, when the truth is **two liked tracks from one album**.

Not every same-titled release is a duplicate. *Wish You Were Here* has 5
tracks; *Wish You Were Here 50* has 30. That is a box set, a different
release.

## The model

**Tables keep every version.** No merging at the fact level. There are three
distinct `Animals` rows on Spotify and there are three rows here, because
each is a real thing with a real URI that playback and playlists need.

**A view groups versions into a work.** One "Master of Puppets", with its
versions hanging off it.

**Metrics count the work once, over the union of likes.** Liking track 3 on
the original and track 7 on the remaster is two liked tracks from one album.

Idin's words: *"on the tables the different versions of the same album should
be as separate records, but a view should take care of those... for the
metrics we use the unique one and we get union of likes"*.

## What makes two releases the same work

Both conditions, not either:

1. **Same normalised title** — trailing parentheticals and bracketed suffixes
   carrying remaster, remix, anniversary, edition, deluxe or mono/stereo
   markers are stripped.
2. **Same track count.**

Title alone would merge a genuine re-recording (a "Taylor's Version") with
its original. Track count alone would merge unrelated albums of the same
length. Together they are conservative: a remaster with a bonus track is
missed, which is the right way to be wrong.

### Live is part of the identity

Never merged with studio. *Delicate Sound of Thunder (Live)* and its 2019
remix merge with each other and never with a studio album of the same name.

**For metrics specifically:** if a work exists in both live and studio, the
live one is ignored — it is mostly the same songs again, and counting it
inflates the artist's totals. If **only** a live version exists, it counts.
Idin's ruling.

## What makes two tracks the same song

Same normalised title **and** comparable duration.

This one has a concrete counter-example Idin gave: *Detroit Rock City* exists
as a long version opening with a radio and car engines, and as a short one
that is just the music. **Those are two different tracks**, and merging them
would lose a real distinction.

So duration is part of track identity, not incidental. Two tracks whose
lengths differ by more than a small tolerance are different songs even under
one title.

## Consolidating likes onto the best version

### What "best" means

The **most recent remaster** of the work. But bonus tracks are not
discarded: where another version carries tracks the newest remaster lacks,
those are included too, each taken from *its* own most recent remaster.

So the best version is not always one release — it is the newest master of
each distinct song in the work.

### How migration happens

**A tool that reports, never acts on its own.** It finds likes sitting on a
worse version and says so. If the list is long it summarises; otherwise it
names the items. The agent may then ask whether to act, and acting is a
separate, confirmed step — same two-step guard as every other destructive
tool here, because unliking is irreversible on Spotify.

Idin accepted that moving a like means unliking the old track, liking the
new one, and swapping it in any playlist that holds it.

### Pinning

A track can be **manually flagged as the best version**, and that flag stays
until Idin undoes it. Nothing overrides a pin — not a newer remaster, not a
re-run of the finder. This is the escape hatch for every case the heuristics
get wrong, and it is why the heuristics are allowed to be simple.

## Schema sketch

```
album_version_of   -- version_uri -> work_key, derived
pinned_track       -- track_uri, pinned_at        (manual, never inferred)
```

Plus views:

```
album_work            -- one row per work, canonical version chosen
work_coverage         -- liked/total over the union, live excluded when
                         a studio version exists
track_best_version    -- for each song in a work, the newest master,
                         respecting pins
```

`album_version_of` is derived rather than stored: it follows from titles and
track counts already in the tables, and storing it would mean recomputing it
whenever a new version appears. `pinned_track` **is** stored, because a pin
is a stated preference and cannot be derived from anything.

## Open

- The normalisation rules need to be built from real titles, not invented —
  the parenthetical vocabulary above came from one artist's discography.
- Duration tolerance for track identity is undecided. A few seconds covers
  fade differences between masters; too wide merges the two *Detroit Rock
  City* versions.
- Whether `work_coverage` replaces `album_coverage` or sits beside it.
