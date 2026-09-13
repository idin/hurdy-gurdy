/**
 * Deciding when two releases are the same album wearing different masters.
 *
 * Spotify lists every reissue as its own release. Pink Floyd's first 24
 * albums contain three exact duplicate pairs — *Animals* and *Animals (2018
 * Remix)*, both 5 tracks; *A Momentary Lapse of Reason* and its 2019 remix,
 * both 11; *The Dark Side of the Moon* and its 50th-anniversary remaster,
 * both 10. Counted separately, that is roughly 12% inflation on an artist's
 * denominator, and it splits the numerator too: a like on the original and a
 * like on the remaster read as one liked track from each of two albums rather
 * than two from one.
 *
 * **The vocabulary here was derived from 234 real titles**, not invented —
 * eight heavily-reissued artists' discographies, suffixes counted. That
 * matters because a list written from imagination would have missed
 * `Re-Mastered` with the hyphen, `Collector's Edition`, and the bare `Mix`
 * that Pink Floyd uses where everyone else writes `Remix`.
 */

/**
 * Suffix words meaning "the same record, mastered again".
 *
 * Ordered by how often they appeared in the sample. A suffix containing any
 * of these is dropped, because it describes the pressing rather than the
 * work.
 */
const MASTER_MARKERS: readonly string[] = [
  "remaster",
  "remastered",
  "re-master",
  "re-mastered",
  "remix",
  "mix",
  "master",
  "anniversary",
  "deluxe",
  "collector",
  "edition",
  "version",
  "expanded",
  "reissue",
  "mono",
  "stereo",
];

/**
 * Suffix words that are part of a record's identity, never stripped.
 *
 * `Live` was the single most common suffix in the sample — 20 of 234 titles —
 * and a live album is a different record from the studio one of the same
 * name, not a different master of it. Idin's ruling: never merge live with
 * studio.
 *
 * A soundtrack is the same kind of distinction: *The Original Soundtrack* is
 * a different release from the album it shares a name with.
 */
const IDENTITY_MARKERS: readonly string[] = ["live", "soundtrack", "demo", "acoustic"];

/** Matches a trailing `(...)` or `[...]` segment. */
const TRAILING_SEGMENT = /\s*[([]([^)\]]*)[)\]]\s*$/;

/** Matches a trailing ` - ...` suffix, the other form reissues take. */
const TRAILING_DASH_SUFFIX = /\s+-\s+([^-]+)$/;

/**
 * Whether a suffix describes a master rather than a different record.
 *
 * Identity wins over master when both appear: `Live at Pompeii (2025 Mix)`
 * names a live record, and the mix marker only says which master of it.
 */
function isMasterSuffix(suffix: string): boolean {
  const lowered = suffix.toLowerCase();
  if (IDENTITY_MARKERS.some((marker) => lowered.includes(marker))) {
    return false;
  }
  return MASTER_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Drop a suffix that says only that the record is live.
 *
 * Liveness is carried in the work key separately, so keeping `(Live)` inside
 * the normalised title would be redundant — and worse, it blocks the stripping
 * of markers beside it. `Delicate Sound of Thunder (Live)` and
 * `Delicate Sound of Thunder (2019 Remix) [Live]` are two masters of one live
 * record and must share a key; leaving the word in gave them different ones.
 *
 * Only a suffix that is *purely* a liveness marker is removed. `Live at
 * Wembley 1974` stays, because a specific performance is a different record
 * from a different night's.
 */
function stripBareLivenessSuffix(title: string): string {
  const bracketed = title.match(TRAILING_SEGMENT);
  if (bracketed !== null && /^live$/i.test(bracketed[1].trim())) {
    return title.slice(0, bracketed.index).trim();
  }
  return title;
}

/**
 * Strip master markers from a release title, leaving the work's name.
 *
 * Applied repeatedly, because titles stack them: *The Dark Side Of The Moon
 * (50th Anniversary) [2023 Remaster]* carries two.
 *
 * @param title - The release title as the provider gave it.
 * @returns The title with master-describing suffixes removed, trimmed and
 *   lowercased for comparison. Never empty — a title that is nothing but
 *   markers keeps its original form rather than becoming a blank key that
 *   would merge with every other blank.
 */
export function normaliseReleaseTitle(title: string): string {
  let working = title.trim();

  for (let pass = 0; pass < MAXIMUM_SUFFIX_PASSES; pass += 1) {
    const bracketed = working.match(TRAILING_SEGMENT);
    if (bracketed !== null && isMasterSuffix(bracketed[1])) {
      working = working.slice(0, bracketed.index).trim();
      continue;
    }
    const dashed = working.match(TRAILING_DASH_SUFFIX);
    if (dashed !== null && isMasterSuffix(dashed[1])) {
      working = working.slice(0, dashed.index).trim();
      continue;
    }
    break;
  }

  // After master markers are gone, a bare liveness marker is redundant: the
  // work key records liveness in its own field.
  working = stripBareLivenessSuffix(working);
  // Stripping (Live) can expose a master marker that was sitting behind it.
  for (let pass = 0; pass < MAXIMUM_SUFFIX_PASSES; pass += 1) {
    const bracketed = working.match(TRAILING_SEGMENT);
    if (bracketed !== null && isMasterSuffix(bracketed[1])) {
      working = working.slice(0, bracketed.index).trim();
      continue;
    }
    break;
  }

  const cleaned = stripLeadingArticle(working.trim().toLowerCase());
  return cleaned.length === 0 ? title.trim().toLowerCase() : cleaned;
}

/**
 * Drop a leading definite article.
 *
 * Found on real data, 2026-09-13: `The Windmills of Your Mind` and
 * `Windmills of Your Mind` were two keys for one song across four pressings
 * in Idin's library. Catalogues disagree about the article constantly, and it
 * never distinguishes two different recordings.
 *
 * Only `the`, and only leading. `A` and `An` are left alone because they
 * genuinely separate titles — *A Day in the Life* is not *Day in the Life* —
 * and a title that is nothing but the article keeps it rather than becoming
 * an empty key.
 */
function stripLeadingArticle(title: string): string {
  const stripped = title.replace(/^the\s+/, "");
  return stripped.length === 0 ? title : stripped;
}

/**
 * How many stacked suffixes to strip.
 *
 * Three covers the worst seen in the sample — an anniversary edition that is
 * also a remaster — and bounds a pathological title rather than looping.
 */
const MAXIMUM_SUFFIX_PASSES = 3;

/**
 * Whether a release is a live recording.
 *
 * Kept separate from the work key because live and studio must never merge,
 * but the distinction is also needed for metrics: when a work exists in both
 * forms the live one is ignored, and when only a live version exists it
 * counts. Idin's ruling.
 *
 * @param title - The release title.
 * @returns True when the title marks it as live.
 */
export function isLiveRelease(title: string): boolean {
  return /\blive\b/i.test(title);
}

/**
 * The key two releases share when they are the same work.
 *
 * Includes the track count, so a 5-track *Wish You Were Here* and a 30-track
 * *Wish You Were Here 50* stay separate — the second is a box set, not a
 * remaster. Title alone would also merge a genuine re-recording with its
 * original, which is a real loss.
 *
 * Includes liveness, so a live album never merges into the studio record it
 * shares a name with.
 *
 * @param release.title - As the provider gave it.
 * @param release.totalTracks - Track count, or null when unreported.
 * @returns A key equal for two releases that are one work.
 */
export function buildWorkKey(release: {
  title: string;
  totalTracks: number | null;
}): string {
  const liveness = isLiveRelease(release.title) ? "live" : "studio";
  // An unknown track count keys as itself rather than as a shared blank:
  // merging on a missing value would group every unreported release together.
  const count = release.totalTracks === null ? "unknown" : String(release.totalTracks);
  return `${normaliseReleaseTitle(release.title)}|${liveness}|${count}`;
}

/**
 * How many seconds two recordings may differ by and still be one song.
 *
 * Masters of the same recording differ by a second or two — fade lengths and
 * gap trimming move between pressings. Genuinely different recordings differ
 * by much more.
 *
 * The case this must not merge is real and Idin's: *Detroit Rock City* exists
 * as a long version opening with a radio and car engines, and a short one
 * that is just the music. Those are two different tracks. Five seconds is
 * comfortably below that gap and comfortably above master drift.
 */
export const SAME_SONG_DURATION_TOLERANCE_SECONDS = 5;

/**
 * The key two recordings share when they are the same song.
 *
 * Duration is part of the identity, not incidental — see the tolerance above.
 * It is bucketed rather than compared, because a key has to be equal or not:
 * two recordings within the tolerance of each other but on opposite sides of
 * a bucket boundary would not match, so the bucket is coarse enough that the
 * boundary case is rare and the pin exists for when it happens.
 *
 * @param track.title - The recording's title.
 * @param track.durationMs - Its length.
 * @returns A key equal for two recordings that are one song.
 */
export function buildSongKey(track: { title: string; durationMs: number }): string {
  const seconds = Math.round(track.durationMs / MILLISECONDS_PER_SECOND);
  const bucket = Math.round(seconds / SAME_SONG_DURATION_TOLERANCE_SECONDS);
  return `${normaliseReleaseTitle(track.title)}|${bucket}`;
}

const MILLISECONDS_PER_SECOND = 1000;
