# The resolver alarm cannot authenticate, so no queued work is ever attempted

## What was expected

`continueResolving` runs from a Durable Object alarm and drains one queued
resolution per tick. Tasks enqueued by a connected session should be worked
through in the background whether or not anyone is connected — that is the
entire reason the work is queued rather than done inline.

## What actually happened

**1,979 `resolve-musicbrainz` tasks have sat in `resolution_queue` since
2026-09-14 with `attempts = 0`.** Not failed — never tried. Measured
2026-09-18:

```
  tasks       1979
  attempts    min=0  max=0  avg=0.0
  oldest      2026-09-14T00:16:50Z
  newest      2026-09-14T20:43:13Z
```

The consequence is that **38 of 4,624 tracks carry a recording MBID**
(0.8%). Every MBID-keyed capability is starved by this: composition
grouping, version comparison, and the AcousticBrainz audio-feature harvest
proposed in `docs/proposals/audio_feature_extraction.md`, which was measured
at a 61% hit rate and would currently reach 23 tracks.

## The cause

`src/index.ts`, in `continueResolving`:

```ts
const accessToken = await getAccessToken(
  this.env.SPOTIFY_TOKENS,
  this.props?.spotifyUserId ?? "",
  { clientId: this.env.SPOTIFY_CLIENT_ID, now: () => Date.now() },
);
```

`this.props` carries the authenticated user and is populated **per
connection**. An alarm is not a connection, so `this.props` is undefined and
the user id falls back to `""`. `getAccessToken` then looks up `kvKey("")`,
finds nothing, and throws `NoSpotifySessionError`.

That throw is caught by the handler's own catch block:

```ts
} catch (error) {
  rateLimited = isSpotifyRateLimited(error);
}
```

which is not a rate-limit error, so `rateLimited` stays false, the task is
left untouched, and the alarm reschedules. The loop runs forever, costs
Durable Object time on every tick, and accomplishes nothing.

**Three things combine, and the third is what hid it:**

1. The token lookup depends on connection state that an alarm does not have.
2. The failure is swallowed by a catch written for a different failure.
3. Nothing increments `attempts` on this path, so the queue looks pristine
   rather than stuck — the one signal that would have shown it.

A task that genuinely fails three times is excluded from selection. A task
that fails *this* way is retried forever with no record, which is why four
days produced zero attempts rather than 5,937 failures.

## Why the MusicBrainz tasks are the visible victims

`resolve-musicbrainz` does not need a Spotify token at all — it reads names
out of the cache and calls ListenBrainz. But the token is fetched *before*
the task kind is examined, so a task needing no Spotify access still dies on
Spotify authentication.

## Proposed fix

Three separate changes, because three separate things are wrong:

1. **Fetch the token only when the task needs it.** Move `getAccessToken`
   inside the branch that requires it, so MusicBrainz resolution runs without
   a Spotify session. This alone unblocks all 1,979 queued tasks.
2. **Persist the user id when a session connects.** A resolver that needs
   Spotify still cannot run from an alarm without one. Store the id in the
   Durable Object's own storage on connect and read it back in the alarm,
   rather than depending on `this.props`.
3. **Record the failure against the task.** The catch block should increment
   `attempts` for any error, not silently swallow everything that is not a
   rate limit. A stuck queue must be visible in the queue.

## Regression test

A test that runs `continueResolving` with no `props` set and asserts a
queued `resolve-musicbrainz` task is attempted. It fails today because the
handler throws before reaching the task.

## Fix applied 2026-09-18

All three changes made:

1. `checkKindNeedsSpotifyToken` in `resolver/resolution_queue.ts` states which
   kinds reach Spotify, as data rather than as call ordering.
   `continueResolving` fetches a token only when it returns true.
2. `findResolverUserId` persists the connected user id into Durable Object
   storage and reads it back from the alarm, so Spotify-backed tasks also
   survive a disconnect.
3. The catch in `continueResolving` now calls `recordResolutionFailure` for
   any non-rate-limit error, so a stuck task shows as attempts rather than
   retrying invisibly.

### Regression test verified to discriminate

`tests/resolver/musicbrainz_needs_no_spotify_token.test.ts`. Reintroducing
the bug by classifying `resolve-musicbrainz` as Spotify-backed:

```
× MusicBrainz resolution needs no Spotify token
× every kind is classified
AssertionError: expected true to be false
AssertionError: expected [ 'artist-album-count', …(3) ] to have a length of 3 but got 4
```

Restored: `Tests  4 passed (4)`. Full suite: `313 passed (313)`.

## Two further bugs found while fixing this one

Both were introduced by the 2026-09-17 milliseconds-to-seconds rename, and
both were invisible to typecheck because the types were still `number`.

### `searchRecording` compared seconds against milliseconds

`musicbrainz_client.ts` compared MusicBrainz's `recording.length`
(milliseconds) against `query.durationSeconds` with a 5,000-unit tolerance.
A 261-second track was compared against 261,973 — off by 1000×, so **no
search result could ever match**. This is the fallback path used when a track
has no ISRC, so it silently disabled half of MusicBrainz resolution.

Caught by the existing tests once the constant was renamed:
`expected undefined to be 'rec-studio'`.

### `buildSongKey` bucketed every track to zero

`normalise_release_title.ts` divided `durationSeconds` by 1,000 before
bucketing. Every track therefore landed in bucket 0, which would have
collapsed all song keys sharing a title — **re-creating exactly the
over-merging Idin caught with the Windmills of Your Mind case on
2026-09-13**.

Verified fixed by building keys directly:

```
  Detroit Rock City long      318s  detroit rock city long|64|a:1
  Detroit Rock City short     218s  detroit rock city short|44|a:1
  Windmills (Noel)            228s  windmills|46|a:1
  Windmills (Sting)           268s  windmills|54|a:1
```

Buckets 64, 44, 46 and 54 are distinct. Before the fix all four were `|0|`.

### The lesson

A rename that changes a value's *unit* cannot be checked by a typechecker
when both units are `number`. Every arithmetic site touching a renamed value
needs reading by hand — and the two found here were both comparisons against
an external API's units, which is where the mismatch is least visible and
most damaging.
