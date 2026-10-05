---
name: import-spotify-export
description: Import Spotify's data-portability export into Hurdy Gurdy's cache — liked tracks, playlists with their added-dates, and play counts with skips. Use when seeding the catalogue, when the cache is cold or thin, when play counts or skip signal are needed for the taste model, or when a question about the whole library cannot be answered through the Web API.
---

# Import the Spotify data export

Spotify's export answers questions the Web API cannot, and answers the rest
far more cheaply. **Prefer it over crawling the API** whenever the question
is about the library as a whole.

| | Export | Web API |
| --- | --- | --- |
| Liked tracks | all in one file | 46 paged calls, output exceeds one context |
| Playlist `addedDate` | yes | **never** |
| Play counts and skips | a year of events | **never** |
| Track duration | **no** | yes |
| Album track count | **no** | yes |
| Artist URI on a track | **no** | yes |

Neither source is sufficient alone. The export seeds; the API completes.

## Step 1 — find the files, do not ask for them

They may already exist on this machine: the user may have requested them
before, and asking them to submit a data request again would be asking for
something already done. Where the files are is personal, so it is in the
user's rules (`~/.claude/rules/local/`), not here. List the files at the
location given there; if no rule names one, ask the user where the export is.

Files that matter:

- `YourLibrary.json` — liked tracks, saved albums, followed artists
- `Playlist1.json` — every playlist with full listings and added-dates
- `StreamingHistory_music_*.json` — play events with `msPlayed`

## Step 2 — read them with the library, never by hand

```ts
import {
  readExportedLibrary,
  readExportedPlaylists,
  readExportedPlays,
  summarisePlays,
} from "hurdy-gurdy/src/export/read_spotify_export";
```

Do not parse these files inline. The shapes have three traps that each
produce silently wrong data, and the readers handle all of them:

1. **A playlist item can have `track: null`** — a local file added through
   the desktop client. Throwing on one entry loses the whole playlist.
2. **The streaming history has no URIs at all**, only names, so joining it is
   a name match and inherently approximate.
3. **`addedDate` sits on the item, the rest on a nested `track` object.**

## Step 3 — import, in this order

```ts
import {
  importLibrary,
  importPlaylists,
  importPlayCounts,
} from "hurdy-gurdy/src/export/import_spotify_export";
```

Order matters: play counts join to tracks, so tracks must exist first.

1. `importLibrary` — liked tracks, saved albums, followed artists
2. `importPlaylists` — playlists and membership
3. `importPlayCounts` — plays and skips onto existing tracks

## Step 4 — the API still has to run

Rows written from the export are deliberately incomplete. They carry no
`song_key`, no `work_key` and no artist links, because the file has no
durations, no album track counts and no artist URIs.

**Until an API read fills those in, the version tools do not work on
export-only rows** — `find_better_versions` cannot compare masters without
durations, and album works cannot merge remasters without track counts.

This is not a defect to fix by inventing the missing values. An earlier
version of the recording layer matched artists by display name and dropped
most of its links; the fix was to carry the identity the API actually sends,
not to guess harder.

## What not to do

**Do not set `is_liked = 0` from the export.** A track in a playlist is not
evidence it is unliked. Every writer uses `MAX` so a flag is never lowered by
an older snapshot — preserve that.

**Do not attribute a play to a track whose name does not match.** The history
join is by name, and a missing play count is visibly missing while a wrong
one corrupts the grading signal the taste model rests on.

**Do not treat the export as current.** It is a snapshot with no live feed —
2,263 liked tracks against 2,282 from the API on 2026-09-13, and a streaming
history that ends where the export was taken. The API path stays.

**Do not ask the user to request the files.** See step 1.
