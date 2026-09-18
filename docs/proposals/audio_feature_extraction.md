# Extracting musical features from audio

Proposed 2026-09-17. Nothing here is built. This records what is possible,
what it would cost, and the constraints that decide which approach is worth
starting.

**Revised 2026-09-18.** The two "cheaper things to check first" were run.
Both came back decisive, and together they reorder the whole plan:

| Check | Result |
| --- | --- |
| Spotify `audio-features` | **403 — withdrawn.** Not a path. |
| AcousticBrainz by MBID | **61% hit rate.** Works, and returns more than expected. |
| *(unasked)* MBID coverage | **38 of 4,624 tracks.** The real bottleneck. |

The third line was not a question this proposal asked, and it turned out to
gate both of the others. Sections below carry their original text with the
measured results marked inline; the Recommendation is rewritten.

## What this would be for

The catalogue currently knows *identity* — this recording is this
MusicBrainz MBID, these are its versions, this one is the best. It knows
nothing about what the music *sounds like*. Tempo, key, and rhythm would
let the catalogue answer questions it currently cannot:

- "something like this but slower"
- "everything I like in a minor key"
- "build a set that ramps from 90 to 140 BPM"
- "is this cover in the same key as the original" — a version-comparison
  question, which is squarely what `find_best_versions.ts` already does

The last one matters most, because it uses audio analysis to improve
something this project already has, rather than adding a capability that
has to justify itself from scratch.

## The source material

There is a real local collection, which is what makes this proposal worth
writing rather than theoretical:

```
~/Library/CloudStorage/GoogleDrive-<account>/My Drive/Music/Idin's Music Collection
```

Measured 2026-09-17:

| | |
| --- | --- |
| Files | 12,511 audio files |
| Formats | 12,443 mp3, 45 wma, 23 flac |
| Total size | 74.7 GB (avg 6.1 MB per file) |
| Organisation | 17 genre folders at top level (Blues, Classical, Iranian, Jazz, Pop-Rock, Opera, …) |

**The files are cloud-only placeholders.** `stat` reports the full apparent
size but `blocks_used=0` — Google Drive streams them on demand rather than
keeping them on disk. This is the single most important constraint here,
and it is covered in its own section below.

## Where analysis can and cannot run

Hurdy Gurdy is a Cloudflare Worker. Analysis cannot run inside it: every
library below is Python, most with C++ or TensorFlow underneath, and a
Worker has no filesystem, no Python runtime, and a hard CPU-time limit per
request.

That is not a blocker, it is a placement decision. The pipeline is a
**separate local tool** that writes features into the catalogue; the Worker
only ever reads them back. Nothing about the Worker changes except gaining
a table to query.

Note also that Spotify does not serve audio files — the Web API returns
metadata only, and extracting audio from the player is a Terms violation.
So the local collection is not merely the easiest source of audio, it is
the only lawful one.

## What is extractable, and how well

Reliability figures are from the published MIR literature, not measured
here.

| Feature | Tool | Reliability |
| --- | --- | --- |
| Tempo (BPM) | librosa, Essentia | High — octave errors (half/double) are the main failure |
| Beat and downbeat positions | madmom, beat-this | High on steady-tempo material |
| Key and mode | Essentia `KeyExtractor`, librosa chroma | Good — roughly 70–85% on pop, weaker on modal and jazz |
| Chord progression | madmom, Chordino | Moderate |
| Onsets, rhythm patterns | librosa | High |
| Timbre (MFCC, spectral centroid, rolloff) | librosa | Exact — measurements, not estimates |
| Loudness and dynamics | pyloudnorm (LUFS), Essentia | Exact |
| Pitch and melody, monophonic | CREPE, pYIN | High |
| Stem separation (drums, bass, vocals) | Demucs | Good |
| Mood, genre, danceability tags | Essentia-TensorFlow models | Moderate, model-dependent |

Two distinctions worth keeping straight. The "exact" rows are
deterministic transforms of the signal — an MFCC is not a guess. The
estimated rows have real error rates, and key detection is wrong often
enough that storing it as a bare fact rather than an estimate with a
confidence would be misleading.

MP3 is not a constraint; decoding goes through ffmpeg via audioread, which
takes the wma and flac files unchanged too.

### Choosing among the three

- **librosa** — pure Python, easiest to install, good at tempo, onsets,
  chroma, MFCC. Weaker at key and beat tracking than the specialists.
- **Essentia** — C++ with Python bindings, the most complete single
  package: key detection, danceability, and pretrained genre and mood
  models in one dependency. Heavier to install.
- **madmom** — state-of-the-art beat and downbeat tracking specifically.
  Old, with real packaging friction on current Python.

**Start with Essentia.** It covers the most ground in one dependency, and
key detection — the weakest link in the table — is the thing it does
better than librosa.

## The real cost is bandwidth, not CPU

This is the part that decides the shape of the pipeline.

Analysing a track requires its bytes. With every file cloud-only, a full
pass means **downloading 74.7 GB** — each file streamed from Drive,
analysed, and (if disk is to be conserved) evicted again. On a 100 Mbit
connection that is roughly 1.7 hours of pure transfer at full saturation,
realistically longer.

CPU is the smaller problem: Essentia on a 4-minute track runs in a few
seconds, and with 10 cores the machine has, a parallel pass over 12,511
files is a few hours. The two overlap, so total wall-clock is likely an
overnight run rather than a week — but it is an overnight run that touches
75 GB of transfer, not a background task to kick off casually.

Consequences for the design, and these are the non-negotiable parts:

1. **Analysis must be resumable and incremental.** A crash at file 9,000
   must not re-download the first 9,000. Keyed by content hash or
   path+mtime, with results committed per file, not per batch.
2. **Analyse once, store forever.** These are derived facts about audio the
   user owns — no licensing restriction, so unlike Spotify Content they
   belong in the permanent catalogue, not the sliding-TTL cache. Re-running
   is expensive enough that it must never be routine.
3. **Order the work by value.** Start with tracks that are in the liked
   library or in playlists. Analysing the entire Christmas compilation
   before anything the user actually listens to is the wrong first
   overnight run.

## Prerequisites

- **ffmpeg is not installed** — `which ffmpeg` finds nothing. Required for
  decoding. `brew install ffmpeg`.
- **System Python is 3.9.6**, too old for comfort with current Essentia
  builds. `uv` is installed, so the pipeline should pin its own newer
  Python rather than touching the system one.
- Where the pipeline lives is an open question — see below.

## File quality, and why it mostly does not matter

Measured 2026-09-17 on a random sample of 40 files, read with `afinfo`.
All were 44.1 kHz:

| Bitrate | Files in sample |
| --- | --- |
| 122–128k | 14 |
| 160–192k | 15 |
| 224–256k | 3 |
| 320k | 8 |

So the collection spans roughly 128k to 320k, with the bulk at 128–192k.

**Re-ripping at higher quality would add almost nothing** for the features
that matter most here. MP3 discards high-frequency content and fine stereo
detail, which is precisely the information these features do not use:

- **Tempo, beat, downbeat** — driven by onset energy in the low-mid range.
  A 128k file preserves percussive transients essentially intact. Published
  MIR benchmarks find beat-tracking accuracy flat from 128k to lossless;
  the remaining errors are octave errors, which are algorithmic rather than
  encoding artifacts.
- **Key and chords** — computed from chroma, which folds energy into 12
  pitch classes concentrated below ~5 kHz. MP3's lowpass sits at 16–20 kHz,
  well clear. The 70–85% ceiling is an algorithm limit, not a file limit.
- **Loudness, dynamics, onsets** — unaffected at these rates.

### Where bitrate does show up

- **Spectral centroid, rolloff, flatness** measure where energy sits across
  the spectrum, so a 128k lowpass at ~16 kHz genuinely shifts them against
  a 320k file at ~20 kHz. A 128k track will read as systematically
  "darker" than a 320k one.
- **Demucs stem separation** produces cleaner stems at higher bitrates.
- **MFCCs** shift slightly; the low-order coefficients most work uses are
  stable.

This is a *comparability* problem, not a correctness one — and since the
whole point is comparing tracks against each other, it is a real one. The
collection's 128k Classical would score as less "rich" than its 320k R&B
purely as an encoding artifact.

**Therefore: store the bitrate alongside every feature vector**, so
timbral comparisons can be normalised or restricted to comparable tiers.
This is cheap at extraction time and impossible to reconstruct later.

Two caveats on the sample: 40 of 12,511 files is small, and two files
(one Soundtrack, one Iranian) returned no bitrate at all — possibly VBR
headers `afinfo` did not parse, possibly corrupt. Worth a full pass once
ffmpeg is installed.

## Richness

"Richness" has no standard definition in the MIR literature. It decomposes
into at least five separately measurable things, and they do not correlate:

| Sense of "rich" | Feature | Bitrate-robust? |
| --- | --- | --- |
| Bright vs. dark timbre | Spectral centroid | No — confounded |
| Harmonically dense, complex chords | Chroma entropy, pitch-class count | Mostly |
| Many simultaneous sources, "thick" | Spectral complexity, flatness | No — confounded |
| Dynamic range, not compressed | Loudness range (LRA), crest factor | Yes |
| Wide stereo image | Stereo width, side/mid ratio | Yes |

Given the mixed-bitrate collection, **the dynamic-range and stereo measures
are the sounder basis for any composite richness score**; the spectral ones
need bitrate normalisation before they can be compared across tiers.

Sensory dissonance / roughness was considered and dropped — not wanted.

## Instrument detection

Two questions that sound alike but are not.

**Which instruments** — multi-label tagging, trained on OpenMIC-2018 (20
instruments) or MedleyDB. Realistically ~0.8 F1 on common instruments,
degrading sharply outside the training set. Relevant warning for this
collection: **the Iranian folder is essentially unsupported.** Tar, setar,
santur, and ney appear in none of these datasets, so a tagger will either
mislabel them as the nearest Western instrument or return nothing usable.

**How many instruments** — mostly unsolved. Polyphonic source-count
estimation works for 2–4 sources in controlled conditions and falls apart
on dense orchestral material, which is exactly where it would be most
wanted. For the Classical and Opera folders a count would be close to
meaningless, and should not be stored as if it were a fact.

**The workable proxy** is Demucs stem separation (drums, bass, vocals,
other) followed by per-stem energy. That reliably answers "has drums / has
bass / has vocals, and how prominent" — not a count, but usually the thing
a count was wanted for.

The cost is the catch: **Demucs runs 10–50× slower than Essentia feature
extraction.** Against 12,511 cloud-only files that turns an overnight run
into a multi-day one. It should be a second pass over a chosen subset, not
part of the first sweep.

## Algorithm names

Verified against the official documentation on 2026-09-17, except where
marked. Essentia's published reference is still tagged `2.1-beta6-dev`, and
neither library was installed locally, so nothing here has been run.

Confirmed from their own doc pages:

| Concept | Essentia algorithm |
| --- | --- |
| Simultaneous sources, "thick" | `SpectralComplexity` (counts spectral peaks) |
| Dynamic range | `DynamicComplexity` (mean absolute deviation from global loudness, dB) |
| Broadcast loudness and range | `LoudnessEBUR128` |
| Harmonic vs. clangorous | `Inharmonicity` — 0 purely harmonic, 1 inharmonic |

`Inharmonicity` is the one real trap: it takes harmonic peak frequencies
and magnitudes, **not raw audio**, so it must be chained after
`HarmonicPeaks`. Two steps, not one call.

Not individually verified — validate before relying on them:

- `Flatness` / `FlatnessDB` — noise-like vs. tone-like
- `Panning`, `StereoDemuxer` — `Panning` exists; that it yields a width
  scalar is unconfirmed
- `KeyExtractor`, or `HPCP` → `Key`
- `RhythmExtractor2013` (tempo), `BeatTrackerMultiFeature` (beats)
- `TensorflowPredictMusiCNN` / `TensorflowPredictVGGish` with OpenMIC or
  MTG-Jamendo models, for instrument and mood tagging

librosa equivalents, signatures confirmed from the 0.11 docs:

```python
librosa.feature.spectral_flatness(*, y=None, S=None, n_fft=2048, hop_length=512, ...)
librosa.feature.spectral_centroid(*, y=None, sr=22050, S=None, n_fft=2048, ...)
```

Same namespace, not individually verified: `spectral_rolloff`,
`spectral_bandwidth`, `spectral_contrast`, `mfcc`, `chroma_cqt`, `rms`,
`zero_crossing_rate`. Tempo lives elsewhere — `librosa.beat.beat_track`.

Confirming these names against a running interpreter is one more thing the
one-genre pilot should settle before the full pass.

## The cheaper thing to check first

Before committing to an overnight 75 GB pass, two sources might supply the
same numbers for free. Neither is a substitute for the local pipeline —
they cover only tracks the services know about, and the collection has
Iranian, Opera, and Classical folders where coverage is likely to be
thin — but if either works it reduces how much has to be analysed locally.

1. ~~**Spotify `GET /audio-features`**~~ — **checked 2026-09-18, and it is
   gone.** A live call with this app's client credentials:

   | Endpoint | Status |
   | --- | --- |
   | `GET /v1/audio-features/{id}` | **403** |
   | `GET /v1/audio-analysis/{id}` | **403** |
   | `GET /v1/tracks/{id}` | 200 |

   The same token succeeds on `/tracks`, so this is a per-endpoint
   withdrawal rather than an auth or quota problem. This confirms what
   `caching_and_catalogue_design.md` already recorded for Client IDs
   created after 27 November 2024 — but it was recorded there as a claim,
   and this is the observation. **Not a path. Do not plan around it.**

2. **AcousticBrainz precomputed features by MBID** — **checked 2026-09-18,
   and it works.** Tested against MBIDs already in this catalogue rather
   than a theoretical sample:

   | Sample | Coverage |
   | --- | --- |
   | First 12 | 11/12 (92%) |
   | All 38 MBIDs in the catalogue | **23/38 (61%)** |
   | 40 freshly-resolved MBIDs (2026-09-18) | **28/40 (70%)** |

   The third row is the one to plan on. It was measured on MBIDs the
   ListenBrainz pass produced after the resolver was fixed — an independent
   set from the 38, and therefore the first coverage figure here not drawn
   from whatever handful happened to already exist.

   **The second row is not a sample — it is the whole population.** The
   catalogue holds recording MBIDs for **38 of 4,624 tracks**, so the
   "random 38" was every MBID there is. 61% is measured on all of them,
   which makes it a solid hit rate and a nearly worthless absolute number:

   | | |
   | --- | --- |
   | Tracks in catalogue | 4,624 |
   | With a recording MBID | **38** (0.8%) |
   | Of those, on AcousticBrainz | 23 |

   Both `/low-level` and `/high-level` return for the same set, so a hit
   gives everything at once.

   **So the harvest would currently reach 23 tracks.** The bottleneck is
   not AcousticBrainz coverage at all — it is that the resolver has mapped
   almost nothing to MusicBrainz yet.

   **What a hit actually returns**, from `/low-level` on *Canned Heat*:

   ```
   bpm                128.03        key                A# major
   beats_count        705           key_strength       0.685
   danceability       1.469         dynamic_complexity 2.980
   spectral_centroid  present       mfcc               present
   ```

   `/high-level` adds 18 classifier outputs: `danceability`, `timbre`,
   `tonal_atonal`, `voice_instrumental`, `gender`, four `genre_*` models,
   eight `mood_*` models, `moods_mirex`, `ismir04_rhythm`.

   **Notably it includes Iranian material** — *Bekhod Residan* was a hit —
   which contradicts this proposal's own prediction that non-Western
   coverage would be thin. One track is not a coverage study, but it is
   evidence the Iranian folder is worth checking rather than written off.

   Caveat worth carrying: the example's `audio_properties` reported
   `bit_rate: 0, lossless: true`, meaning the submitter analysed a lossless
   file. AcousticBrainz features come from **someone else's copy**, not
   Idin's 128k one. That is a *feature* for the comparability problem this
   proposal raises — the whole collection would be scored from consistent
   sources — but it also means a local re-analysis of the same track will
   not reproduce these numbers exactly.

## Recommendation

**Revised 2026-09-18, after running both coverage checks.** They changed
the order: Spotify is closed, AcousticBrainz is open, and the cheapest
useful thing is now a network call rather than a 75 GB download.

1. ~~**Finish MBID resolution before anything else.**~~ **In progress
   2026-09-18.** This was the actual bottleneck and it was invisible until
   the numbers were checked: 38 of 4,624 tracks carried a recording MBID,
   so every MBID-keyed source — AcousticBrainz, composition grouping,
   everything the permanent catalogue is built on — reached under 1% of the
   library.

   Three causes, all now fixed:

   | Cause | Fix |
   | --- | --- |
   | The resolver alarm could not authenticate, so 1,979 queued tasks were never attempted | `docs/bugs/resolved/2026-09-18_resolver_alarm_cannot_authenticate_without_a_connection.md` |
   | The resolver called MusicBrainz directly at 1 req/sec, not ListenBrainz at 30 per 9s | `resolve_artist_totals.ts` now maps through ListenBrainz and calls MusicBrainz only for the work relation |
   | `searchRecording` compared seconds against milliseconds, so no search could ever match | Same bug log |

   The ListenBrainz path is verified working — 4 of 5 spot-checked tracks
   matched, including the Windmills case — and a full pass over the queued
   tracks is running. Whatever it yields multiplies directly into the
   AcousticBrainz figure below, because that harvest is keyed on exactly
   these MBIDs.
2. **Then harvest AcousticBrainz.** It needs no ffmpeg, no Python, no audio
   and no local files — only MBIDs. At a 61% hit rate it answers tempo,
   key, loudness, timbre and 18 classifier outputs for three in five
   resolved tracks, one HTTP call each. A
   `catalogue/acousticbrainz_client.ts` beside the existing
   `listenbrainz_client.ts`, not a new subsystem.
3. **Then measure what is left.** Only after those two is the local
   pipeline's real scope known: tracks AcousticBrainz does not cover,
   intersected with tracks Idin actually listens to. That may be small
   enough that the overnight 75 GB pass is never worth running.
4. Install ffmpeg and stand up the Essentia pipeline against **one genre
   folder**, not the whole collection. This validates four things at once
   on a few hundred files instead of twelve thousand: extraction works, the
   unverified algorithm names in "Algorithm names" are real, MBID matching
   succeeds on these filenames, and the resume logic holds.
5. Only once that folder round-trips into the catalogue correctly, queue
   whatever the step-3 measurement says is left.
6. Treat Demucs as a **separate later pass** over a chosen subset. At
   10–50× the cost of feature extraction it does not belong in the first
   sweep.

The reordering is the substantive change. The original plan treated a local
pipeline as the main event and the free sources as a way to shrink it. The
measurement moves both: **the free source is better than expected, and
neither is reachable yet**, because MBID resolution — a step the proposal
did not mention at all — gates everything downstream of it.

The proposal's own stated failure mode was "starting the 75 GB download
before knowing whether MBID matching works." That was the right instinct
aimed at the wrong place: matching from *filenames* is indeed untested,
but matching from the *Spotify catalogue*, which is already built and
already works, has simply not been run.

Store bitrate with every feature vector from the very first file. It costs
nothing at extraction time and cannot be reconstructed afterwards without
re-downloading.

The failure mode to avoid is starting the 75 GB download before knowing
whether MBID matching works on this collection's filenames. Matching is
the part most likely to be quietly wrong, and it costs nothing to test.

## Open questions

~~- Does `GET /audio-features` still return data for this app's
credentials?~~ **Answered 2026-09-18: no, 403.**

~~- What is AcousticBrainz coverage over a sample of the collection?~~
**Answered 2026-09-18: 61% of catalogue MBIDs (23/38 random).** Still open
for the *folders* specifically — the sample was drawn from the Spotify-derived
catalogue, not from the local collection, so Opera and Classical coverage
is untested. One Iranian track was a hit.

- How do files map to MBIDs? Is there usable ID3 metadata, or does matching
  have to work from `Artist - Title.mp3` filenames? Untested, and **now the
  highest-risk unknown in the proposal by a wide margin** — it gates the
  local pipeline entirely, and the AcousticBrainz harvest sidesteps it only
  for tracks the resolver already mapped from Spotify.
- How much would extending recording-MBID coverage raise the effective
  AcousticBrainz yield? The 61% is of *resolved* tracks, so unresolved ones
  score zero regardless of whether AcousticBrainz holds them.
- Where does the pipeline live — a `scripts/` subfolder here, or its own
  repo? It shares the catalogue but nothing else, and it is Python in a
  TypeScript project. **Unanswered — this blocks writing any code.**
- Should estimated features (key especially) carry a confidence value, and
  would any consuming query actually respect it?
- Does a composite "richness" score get stored, or only its components?
  Storing components is safer, since any composite bakes in a weighting
  that cannot be revisited without a re-run.
- What happens to Iranian and other non-Western material, where instrument
  tagging has no training data and key detection assumes Western
  tonality? Storing confidently wrong values may be worse than storing
  nothing.
- How many files have unreadable or VBR headers? Two of 40 sampled did.
- What is in `Decommissioned`, and should it be analysed at all?
