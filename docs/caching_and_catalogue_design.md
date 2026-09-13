# Caching and the permanent catalogue

Decided 2026-09-13. Nothing here is built yet; this records the design and
the reasoning before any code exists, so the structure is a decision rather
than something discovered after a pile has formed.

## The problem

Every tool call currently hits the live Spotify API. Nothing is kept. Three
things are wanted instead:

1. **Don't refetch what hasn't changed** — but notice when it has, e.g. when
   a new artist is followed.
2. **Expire what isn't used**, with the expiry pushed back every time an
   entry is read, so a working set stays warm and a one-off query falls out.
3. **Keep a permanent catalogue** that survives expiry and is portable to
   YouTube Music and Apple Music.

## Why this is two stores, not one

Spotify's Developer Terms v10, section IV:

> you may not store, aggregate or create compilations or databases of
> Spotify Content, other than as strictly necessary to operate your SDA

> Do not store Spotify Content indefinitely.

Only "temporary caching of: metadata and cover art" is permitted. The
original rule for this project — fetch once, store permanently, never fetch
twice — cannot be followed for Spotify as stated.

So the design splits by **who owns the data**, not by how it is used:

| Store | Contents | Lifetime | Why it is allowed |
| --- | --- | --- | --- |
| **Spotify cache** | raw API responses | sliding TTL, 66 days | "temporary caching" — entries genuinely expire |
| **Catalogue** | MusicBrainz-keyed facts | permanent | MusicBrainz data is CC0; no storage restriction |

The catalogue holds Spotify IDs only as a refreshable lookup column, never
as identity. That is what makes the whole thing portable: adding YouTube
Music means adding another lookup column against the same rows, not a second
catalogue.

## Freshness: three tiers, cheapest first

The question "has this changed?" is answered as cheaply as possible before
anything is refetched.

1. **ETag / `If-None-Match`.** Every cached response stores its ETag. A
   revalidation that returns `304 Not Modified` costs no quota and renews the
   entry. This is the common case.
2. **Collection totals.** `GET /me/following?limit=1` returns the collection's
   `total` without fetching any pages. A changed total means the collection is
   stale. **This is what catches "I followed a new artist"** without walking
   the whole list.
3. **Sliding TTL.** The floor. Nothing is trusted forever, even if no signal
   says it changed.

## Sliding expiry, precisely

Each row carries `expires_at`.

- Read where `expires_at > now` → **hit**, and the read sets
  `expires_at = now + TTL`. Using something keeps it alive.
- Read where `expires_at <= now` → revalidate by ETag. `304` refreshes it
  cheaply; `200` replaces the content.
- A periodic sweep **deletes** rows past expiry, which is what makes "do not
  store indefinitely" literally true rather than merely claimed.

**TTL: 66 days.** Idin's number. Long enough that anything touched even
occasionally stays warm; short enough that genuinely unused Spotify content
leaves the system.

## The MusicBrainz resolver

Spotify does not return MusicBrainz IDs, so something must resolve
`Spotify artist/album` → MBID before anything can enter the permanent
catalogue.

**Rate limit, confirmed from MusicBrainz's own documentation
(`musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting`, read 2026-09-13):**
1 request per second per IP, averaged. Exceeding it returns `503` on *all*
requests until the rate drops. A User-Agent identifying the application and
giving a reachable contact is required.

**User-Agent:** `hurdy-gurdy/0.2.0 ( idin@ixmachina.ai )`

### Why a continuous background queue

Idin's constraint: *"usage limit we dont use doesn't get carried over"*. An
unused second of MusicBrainz quota is gone forever. A lazy resolver — only
resolving when something is needed — wastes nearly all of it. An eager one
blocks the user on a rate-limited crawl.

So neither: a **Durable Object alarm fires every second, takes one item off
a priority queue, resolves it, and reschedules.** Never idle while work
exists, never over the limit. Capacity is only lost when the queue is empty.

`other-memory` already drives its index build from a DO alarm, so this is a
proven pattern in this codebase rather than a novel one.

### Priority, highest first

| Tier | What | Why |
| --- | --- | --- |
| 0 | something just asked about | someone is waiting on it now; preempts |
| 1 | followed artists | the identity spine — albums and tracks hang off these |
| 2 | albums and tracks in liked/saved collections | the bulk of a library |
| 3 | anything seen once in a search result | speculative; may never matter |

### What it costs in wall-clock time

At 1/sec, unattended: ~500 followed artists is ~8 minutes. ~5,000 liked
tracks is ~1.4 hours. Both happen once; afterwards only new items enqueue.

### Nothing blocks on it

A tool call returns immediately from the Spotify cache. If an MBID is not
resolved yet the row returns `musicbrainz_id: null` and the item enqueues at
tier 0. The catalogue fills in behind the user rather than in front of them.

## Schema requirements this must satisfy

Recorded by Idin on 2026-09-11, before any of this was designed:

- **Multiple artists per work.** Compilations, collaborations, features.
  Never one artist per song or album.
- **Graph traversal**, not only flat lookups and vector similarity.
  Relationships between artists, works and releases must be renderable.
- **No records that get falsified.** Specifically: an artist may release
  nothing for years and then release again, so a stored "end date" is a
  record that goes wrong on its own. Absence of activity is not an ending.
- **Lazy scope.** Only artists, albums and songs actually touched — never a
  full catalogue load up front.

## File layout

Decided before code, per `~/.claude/rules/generic/meta.md`.

```
src/cache/
  cache_entry.ts          expires_at, etag, the sliding renewal rule
  spotify_cache.ts        the expiring Spotify layer over D1
  freshness_check.ts      ETag revalidation + collection-total staleness
src/catalogue/
  catalogue_schema.ts     MusicBrainz-keyed tables, multi-artist joins
  provider_id_lookup.ts   spotify_id / ytmusic_id -> mbid
src/resolver/
  resolution_queue.ts     the priority queue
  musicbrainz_client.ts   1 req/sec, identified User-Agent
  resolver_alarm.ts       the DO alarm loop
```

Storage is **D1**, chosen over KV and DO storage because the graph
requirement and the multi-artist schema both need joins and querying across
rows, which a key-value store cannot do.

## Open, not yet decided

- **Genre vocabulary.** Idin trusts AllMusic's classifications over other
  sources and asked whether they can feed the taste embedding. AllMusic has
  no public API, so how that data arrives is unresolved.
- **The taste embedding itself.** Spotify withdrew `audio-features`,
  `audio-analysis`, `recommendations` and `related-artists` for Client IDs
  created after 27 November 2024 — exactly the tempo/key/time-signature
  fields the embedding was to be built from. MusicBrainz and AcousticBrainz
  are the candidate replacements. Not designed.
- **Whether the resolver runs when nobody is connected.** A DO alarm can run
  indefinitely; whether it should, given that it is doing work for a user who
  may not return for weeks, is a cost question nobody has ruled on.
