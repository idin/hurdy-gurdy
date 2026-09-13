# Play counts are duplicated across pressings of the same song

## What was expected

Importing the streaming history gives each track its own play count.

## What actually happened

A song that exists as several pressings gets the **same count written to each
of them**, so the plays are multiplied by the number of copies in the library.

Observed immediately after the first import, 2026-09-13:

```
   21 plays   7 skips  Eye In The Sky        2026-07-02 15:46
   21 plays   7 skips  Eye In The Sky        2026-07-02 15:46
   21 plays   7 skips  Eye In The Sky        2026-07-02 15:46
```

Three rows, one song, 21 plays reported three times.

**450 track names are duplicated** among the 2,955 rows carrying a count, and
the summed play total reads 7,297 against a true figure that is lower by
however many duplicates each has.

## Why

`scripts/build_export_import_sql.ts` writes:

```sql
UPDATE track SET play_count = ?, skip_count = ?, last_played = ?
 WHERE LOWER(name) = LOWER(?);
```

Matching on **name alone**. The streaming history carries no URIs — only
artist and track names — so there is nothing better to match on *from the
export*. Every row whose name matches gets the count.

`importPlayCounts` in `src/export/import_spotify_export.ts` is narrower: it
also requires the artist to match through `track_artist`. That is better but
does not fix this, because several pressings of a song by the same artist
still all match.

## The real fix

`song_key` exists for exactly this, and groups pressings of one recording by
normalised title plus duration bucket. A play count belongs to the **song**,
not to each pressing of it.

Two things have to happen first:

1. **`song_key` must be populated.** It is null on every imported row,
   because the export carries no durations. An API read supplies them.
2. **The count should be stored once per song and read through a view**, in
   keeping with the rule that nothing derived is stored per-row. A
   `song_play_count` view over the history, or a `song_plays` table keyed on
   `song_key` that the track rows join to.

Until then the counts are **directionally right and numerically inflated**
for any song with more than one pressing. Do not use them for anything that
sums across tracks.

## Not yet fixed

Logged rather than patched. Patching it by matching on artist as well would
reduce the inflation without removing it, and would look like a fix — which
is worse than a known-wrong number that is documented as wrong.
