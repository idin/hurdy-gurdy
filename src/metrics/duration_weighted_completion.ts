/**
 * Weighting a song's completion by how long the song is.
 *
 * ## The problem this solves
 *
 * Two facts about listening pull in opposite directions, and Idin named both:
 *
 * > *"a long song is different from short song, if i listen to most of shine
 * > on you crazy diamond, it is still more significant than if i listen to all
 * > of a short song"*
 *
 * > *"another thing is maybe normalizing per length is actually useful, amount
 * > of song listened to / total song length"*
 *
 * The first says absolute time matters; the second divides it away. They
 * cannot both be satisfied by one number, because they disagree about what the
 * number means — an attention *rate* versus an attention *total*.
 *
 * ## The resolution
 *
 * An exponent on the length factor, which makes the two into endpoints of one
 * family rather than rival metrics:
 *
 * | Exponent | Behaviour |
 * | --- | --- |
 * | 0 | pure ratio — `mean_squared_completion_ratio` unchanged |
 * | 0.5 | square root — a 4x longer song counts 2x more |
 * | 1 | pure elapsed time |
 *
 * Measured on Idin's library, where lengths span 52x (29s to 1,526s), the
 * exponent decides which songs can appear at all. At 0 the top is short pop
 * and *The End* (11 minutes) sits at rank 349. At 1 the list is entirely long
 * songs and the short ones are gone — the 52x spread becomes a 52x thumb on
 * the scale. At 0.5 both kinds coexist: *Comfortably Numb* leads, *Why Worry?*
 * and *Brothers In Arms* appear for the first time, and *Another Brick in the
 * Wall* and *The Trooper* are still there.
 *
 * ## Why divide by the library median
 *
 * So the exponent changes the tilt without changing the scale. A
 * median-length song has a factor of exactly 1.0 at every exponent, which
 * means scores stay comparable as the dial moves — and the number keeps
 * meaning "relative to a typical song in this library" rather than "seconds
 * raised to a power", which is not a unit anyone can reason about.
 */

/**
 * How strongly a song's length tilts its score.
 *
 * 0.5 — the square root — chosen because it is where both long and short
 * songs remain visible in the same ranking. Against the library's 52x length
 * spread, a linear weight gives a 52x advantage and flattens the list to
 * epics alone; the square root gives 7x, which is a tilt rather than a
 * takeover.
 *
 * Named an exponent rather than a weight or an emphasis because that is what
 * it is: someone setting it to 2 expecting "twice as much length" would get
 * length squared. The name is the warning.
 */
export const DEFAULT_LENGTH_WEIGHT_EXPONENT = 0.5;

/** What the calculation needs about one song. */
export type SongCompletion = {
  /** The song's mean squared completion ratio, from `track_plays`. */
  meanSquaredCompletionRatio: number;
  /** The song's length in seconds. */
  durationSeconds: number;
};

/**
 * Score a song by completion, tilted toward longer songs.
 *
 * @param song - Its mean squared completion and its length.
 * @param medianDurationSeconds - The library's median song length, which makes
 *   the length factor a comparison against a typical song rather than an
 *   absolute. Must be positive; a library with no known durations has no
 *   median and cannot be scored this way.
 * @param lengthWeightExponent - How strongly length counts. Zero recovers the
 *   unweighted completion exactly; one makes the score proportional to
 *   elapsed time.
 * @returns The weighted score. Not bounded by 1: a long song heard completely
 *   scores above a short one heard completely, which is the entire point.
 */
export function calculateDurationWeightedCompletion(
  song: SongCompletion,
  medianDurationSeconds: number,
  lengthWeightExponent: number = DEFAULT_LENGTH_WEIGHT_EXPONENT,
): number {
  if (medianDurationSeconds <= 0 || song.durationSeconds <= 0) {
    return 0;
  }

  const lengthFactor = (song.durationSeconds / medianDurationSeconds) ** lengthWeightExponent;
  return song.meanSquaredCompletionRatio * lengthFactor;
}

/**
 * The middle value of a list of song lengths.
 *
 * Median rather than mean, because a handful of 25-minute pieces drag a mean
 * upward and would make every ordinary song look short by comparison. The
 * median is what "a typical song in this library" actually means.
 *
 * @param durationsSeconds - Every known song length. Order does not matter.
 * @returns The median, or null when there is nothing to take a median of.
 */
export function findMedianDuration(durationsSeconds: number[]): number | null {
  const usable = durationsSeconds.filter((duration) => duration > 0);
  if (usable.length === 0) {
    return null;
  }

  const sorted = [...usable].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
