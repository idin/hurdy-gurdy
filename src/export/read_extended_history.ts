/**
 * Reading Spotify's *extended* streaming history.
 *
 * A different file from the account export's `StreamingHistory_music_*.json`,
 * and a far better one. Twenty-three fields per play against four, ten years
 * against one, and — decisively — **a Spotify track URI on every play**.
 *
 * | | Account export | Extended history |
 * | --- | --- | --- |
 * | Plays | 15,599 | **58,521** |
 * | Track URI | none | **58,327 of them** |
 * | Timestamp | minute resolution | **second resolution** |
 * | Skips | inferred from `msPlayed` | **an explicit flag, plus a reason** |
 * | Span | one year | **2016 to 2026** |
 *
 * Kept as its own module rather than folded into `read_spotify_export.ts`
 * because the shapes share nothing: different field names, different
 * timestamp format, different identity. Merging them would mean a reader full
 * of branches asking which export it was handed.
 */

/**
 * One play, as the extended history records it.
 *
 * Named exactly as the file names them — `ms_played`, not `msPlayed` — so a
 * reader comparing this type against the JSON does not have to translate.
 */
export type ExtendedPlay = {
  /** ISO-8601 with seconds, e.g. `2026-01-01T00:33:40Z`. */
  ts: string;
  ms_played: number;
  spotify_track_uri: string | null;
  master_metadata_track_name: string | null;
  master_metadata_album_artist_name: string | null;
  master_metadata_album_album_name: string | null;
  /**
   * Why playback began: `clickrow`, `trackdone`, `fwdbtn`, `backbtn`,
   * `playbtn`, `autoplay` and others.
   */
  reason_start: string | null;
  /**
   * Why playback ended.
   *
   * The most valuable field in the file. `trackdone` means it played out;
   * **`fwdbtn` means the skip button was pressed** — an explicit rejection
   * rather than a track that happened to stop. Observed in Idin's history:
   * 23,528 `trackdone` against **22,809 `fwdbtn`**.
   */
  reason_end: string | null;
  /** Spotify's own judgement, rather than a threshold applied afterwards. */
  skipped: boolean | null;
  /**
   * Whether shuffle was on.
   *
   * Distinguishes rejecting something *offered* from rejecting something
   * *queued deliberately* — an open question in the span proposal that this
   * field answers outright.
   */
  shuffle: boolean | null;
  platform: string | null;
  offline: boolean | null;
  incognito_mode: boolean | null;
};

/**
 * `reason_end` values meaning the listener actively moved on.
 *
 * `fwdbtn` is the skip button. `endplay` is stopping playback outright.
 * Both are choices; `trackdone` and `logout` are not.
 */
const DELIBERATE_END_REASONS: ReadonlySet<string> = new Set(["fwdbtn", "endplay"]);

/**
 * Parse one `Streaming_History_Audio_<year>.json`.
 *
 * @param raw - The file's contents.
 * @returns Every play in it, in file order.
 */
export function readExtendedHistory(raw: string): ExtendedPlay[] {
  return JSON.parse(raw) as ExtendedPlay[];
}

/**
 * Whether a play was a deliberate rejection.
 *
 * Prefers `reason_end` over the `skipped` flag, because a reason says *how*
 * it ended and the flag only says that it did. A track abandoned by a logout
 * or an app crash is not a rejection of the track, and both can set
 * `skipped`.
 *
 * @param play - The play to judge.
 * @returns True when the listener actively moved on.
 */
export function isDeliberateSkip(play: ExtendedPlay): boolean {
  return play.reason_end !== null && DELIBERATE_END_REASONS.has(play.reason_end);
}

/** What the extended history says about one track. */
export type ExtendedPlaySummary = {
  trackUri: string;
  trackName: string | null;
  artistName: string | null;
  /** Plays that ran to the end. */
  completedCount: number;
  /** Plays the listener actively skipped past. */
  skippedCount: number;
  /** Plays that ended some other way — a logout, a crash, a device change. */
  otherCount: number;
  totalMsPlayed: number;
  /** ISO timestamp of the most recent play. */
  lastPlayed: string;
  /** How many of these plays happened with shuffle on. */
  shuffledCount: number;
};

/**
 * Reduce plays to per-track counts, keyed by Spotify URI.
 *
 * Three outcomes rather than two. A completed play and a skipped play are
 * opposite signals; a play cut short by a logout is neither, and folding it
 * into either would be inventing an opinion the listener never expressed.
 *
 * @param plays - Every play, from every year file.
 * @returns One summary per track URI.
 */
export function summariseExtendedPlays(
  plays: ExtendedPlay[],
): Map<string, ExtendedPlaySummary> {
  const summaries = new Map<string, ExtendedPlaySummary>();

  for (const play of plays) {
    const uri = play.spotify_track_uri;
    if (uri === null) {
      // Podcasts and audiobooks share this file and have no track URI.
      continue;
    }

    const existing = summaries.get(uri) ?? {
      trackUri: uri,
      trackName: play.master_metadata_track_name,
      artistName: play.master_metadata_album_artist_name,
      completedCount: 0,
      skippedCount: 0,
      otherCount: 0,
      totalMsPlayed: 0,
      lastPlayed: play.ts,
      shuffledCount: 0,
    };

    if (play.reason_end === "trackdone") {
      existing.completedCount += 1;
    } else if (isDeliberateSkip(play)) {
      existing.skippedCount += 1;
    } else {
      existing.otherCount += 1;
    }

    existing.totalMsPlayed += play.ms_played;
    existing.shuffledCount += play.shuffle === true ? 1 : 0;
    if (play.ts > existing.lastPlayed) {
      existing.lastPlayed = play.ts;
    }

    summaries.set(uri, existing);
  }

  return summaries;
}
