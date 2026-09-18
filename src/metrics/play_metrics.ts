/**
 * What one play says about a song.
 *
 * Every aggregate in the library — how much a song is liked, whether it is
 * sought out, whether it is rejected — reduces to one number per play: what
 * share of the song was heard. This file defines that number and the judgement
 * built on it.
 *
 * ## Why a ratio rather than a count of skips
 *
 * Spotify records `reason_end`, and `fwdbtn` means the skip button was
 * physically pressed. That is observed fact and needs no threshold. But the
 * button says nothing about *when* it was pressed: 1.1% of Idin's skip presses
 * came after 90% of the song had played, which is moving on from an outro, not
 * rejecting a track.
 *
 * The completion ratio handles that on its own. A press at 0.95 contributes
 * 0.95; a press at 0.03 contributes 0.03. No cutoff is consulted, which is
 * what Idin asked for: *"I don't like binary ways of creating these metrics."*
 *
 * A separate skip *flag* still exists, because a count of rejections is a
 * different question from an average of engagement — and that flag is the one
 * place a threshold is unavoidable. It is derived by clustering rather than
 * chosen; see `cluster_skip_threshold.ts`.
 */

import type { SkipThreshold } from "./cluster_skip_threshold";

/** One play, reduced to the two quantities every metric is built from. */
export type PlayDuration = {
  /** Seconds actually heard, converted from the history's milliseconds. */
  secondsPlayed: number;
  /** The song's full length in seconds, fractional. */
  durationSeconds: number;
};

/**
 * What share of the song one play heard, from 0 to 1.
 *
 * **Clamped at 1, and the clamp does real work.** 13.56% of Idin's plays
 * report more time played than the track is long — mostly by a fraction of a
 * second, but up to 3.0x, where 787 seconds were logged against a 261-second
 * song. Those rows are a song left looping or a duration read from a
 * different pressing, and without the clamp a single one of them would
 * contribute as much as three complete listens.
 *
 * The clamp costs about 1% of the library's total weight, so it protects
 * individual songs from a bad row without distorting the whole.
 *
 * @param play - The play's heard and total durations.
 * @returns A fraction from 0 to 1. Zero when the duration is unknown, since
 *   no honest share can be computed without it.
 */
export function calculateCompletionRatio(play: PlayDuration): number {
  if (play.durationSeconds <= 0) {
    return 0;
  }
  return Math.min(play.secondsPlayed / play.durationSeconds, 1);
}

/**
 * Whether a play was a genuine rejection.
 *
 * Three conditions, all required. The play must have ended with the skip
 * button — an observed act, not an inference. And **both** the completion
 * ratio and the seconds heard must fall below their clustered thresholds,
 * because either alone misjudges one end of the length range:
 *
 * | Play | Ratio alone | Clock alone | Both |
 * | --- | --- | --- | --- |
 * | 267s of Boléro (933s) | skip | listened | **listened** |
 * | 34s of *Maggie Mae* (40s) | listened | skip | **listened** |
 * | 2s of a 235s song | skip | skip | **skip** |
 *
 * The two agreed on 97.6% of Idin's skip presses; where they differed, the
 * pairing was right and the single rule was wrong in both directions.
 *
 * @param play - The play's durations and how it ended.
 * @param threshold - From `clusterSkipThreshold`, derived from this library.
 * @returns True when the listener rejected the song rather than moving on
 *   from it.
 */
export function checkPlayWasSkipped(
  play: PlayDuration & { reasonEnd: string | null },
  threshold: SkipThreshold,
): boolean {
  if (play.reasonEnd !== SKIP_BUTTON_END_REASON) {
    return false;
  }

  return (
    calculateCompletionRatio(play) < threshold.completionRatio
    && play.secondsPlayed < threshold.secondsHeard
  );
}

/**
 * The `reason_end` value meaning the skip button was pressed.
 *
 * Deliberately narrower than the set used for counting deliberate endings:
 * `endplay` stops playback altogether, which is leaving rather than rejecting
 * this particular song.
 */
const SKIP_BUTTON_END_REASON = "fwdbtn";

/**
 * `reason_start` values meaning the listener chose this song.
 *
 * `clickrow` is picking it from a list, `playbtn` is pressing play on it,
 * `remote` is starting it from another device. Everything else arrived on its
 * own — including `fwdbtn`, which as a *start* reason means the previous track
 * was rejected and this one was merely next. That distinction covers 39.5% of
 * Idin's plays, so getting it wrong would misread most of the history.
 */
const CHOSEN_START_REASONS: ReadonlySet<string> = new Set(["clickrow", "playbtn", "remote"]);

/**
 * Whether the listener chose this play rather than receiving it.
 *
 * @param reasonStart - The play's `reason_start`.
 * @returns True when the play was started deliberately.
 */
export function checkPlayWasChosen(reasonStart: string | null): boolean {
  return reasonStart !== null && CHOSEN_START_REASONS.has(reasonStart);
}
