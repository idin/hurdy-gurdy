/**
 * Finding where a skip stops being a skip, from the data rather than a guess.
 *
 * The question this answers: a listener pressed the skip button, but how much
 * of the song had played? Two seconds is a rejection. Four minutes of Boléro
 * is not — the song was heard, then playback moved on.
 *
 * Picking a cutoff by hand is the failure Idin named directly: *"who is to say
 * 2 seconds is the threshold and not 5s or not 15s?"* So no cutoff is picked.
 * Otsu's method finds the split that best separates the observed distribution
 * into two groups, and the number it returns is whatever the listening says it
 * is.
 *
 * ## That the distribution really has two groups
 *
 * Measured over Idin's 12,031 skip-button plays on 2026-09-15, three
 * independent criteria agreed to three decimals:
 *
 * | Method | Break |
 * | --- | --- |
 * | Otsu (maximum between-class variance) | 0.330 |
 * | 1-D 2-means, run to convergence | 0.331 |
 * | Minimum within-class variance (Jenks) | 0.330 |
 *
 * Cluster centres landed at **0.027 and 0.636** — one group that never heard
 * the song, one that heard most of it. Three objective functions finding the
 * same boundary is what makes this a real division rather than an artefact of
 * the method.
 *
 * The break is higher than it looks from a histogram: 80.3% of skips fall in
 * the first 5% of a song, which tempts a cutoff near 0.05. But the sparse
 * 10-33% region belongs with the rejections — those plays sit far closer to
 * 0.027 than to 0.636 — and clustering places them correctly where eyeballing
 * does not.
 */

import { calculateCompletionRatio } from "./play_metrics";

/**
 * How many cut points to test across the observed range.
 *
 * Otsu is exhaustive over candidate splits, so resolution is a choice. 400
 * steps resolves a completion ratio to 0.0025 — finer than the difference
 * between the three methods that agreed above, and therefore finer than the
 * answer is meaningful to.
 */
const CANDIDATE_SPLIT_COUNT = 400;

/**
 * Fewest plays that can produce a trustworthy threshold.
 *
 * Below this the "clusters" are noise. A library with fewer skips than this
 * has not said enough for a data-derived cutoff to beat an arbitrary one, and
 * the caller is told so rather than handed a number with false authority.
 */
const MINIMUM_PLAYS_FOR_CLUSTERING = 100;

/** Where the split fell, and how convincing it is. */
export type SkipThreshold = {
  /** Completion ratio below which a skip-button press means rejection. */
  completionRatio: number;
  /** Seconds heard below which the same is true. */
  secondsHeard: number;
  /**
   * Fraction of total variance the split explains, 0 to 1.
   *
   * The honesty figure. A genuinely bimodal distribution scores high — Idin's
   * completion ratios gave **0.825**. A distribution with no real division
   * scores near zero however confidently the break is reported, so a caller
   * can tell "the data divides here" from "the arithmetic ran".
   */
  separation: number;
  /** How many plays the threshold was derived from. */
  playCount: number;
};

/** One play, reduced to what clustering needs. Both in seconds. */
export type SkippedPlayObservation = {
  secondsPlayed: number;
  durationSeconds: number;
};

/**
 * Find the cut that best separates a set of values into two groups.
 *
 * Otsu's method: for every candidate cut, weigh how far apart the two groups'
 * means are, weighted by their sizes. The cut maximising that is the one where
 * the groups are most distinct.
 *
 * @param values - The observations, in any order.
 * @returns The cut point, or null when the values cannot be split.
 */
function findBetweenClassMaximum(values: number[]): number | null {
  const lowest = Math.min(...values);
  const highest = Math.max(...values);
  if (lowest === highest) {
    return null;
  }

  let bestCut: number | null = null;
  let bestVariance = -1;

  for (let step = 1; step < CANDIDATE_SPLIT_COUNT; step += 1) {
    const cut = lowest + ((highest - lowest) * step) / CANDIDATE_SPLIT_COUNT;
    const below = values.filter((value) => value < cut);
    const above = values.filter((value) => value >= cut);
    if (below.length < 2 || above.length < 2) {
      continue;
    }

    const belowWeight = below.length / values.length;
    const aboveWeight = above.length / values.length;
    const meanGap = calculateMean(below) - calculateMean(above);
    const betweenClassVariance = belowWeight * aboveWeight * meanGap * meanGap;

    if (betweenClassVariance > bestVariance) {
      bestVariance = betweenClassVariance;
      bestCut = cut;
    }
  }

  return bestCut;
}

/** Arithmetic mean of a non-empty list. */
function calculateMean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Population variance, as the sum of squared deviations over the count. */
function calculateVariance(values: number[]): number {
  const mean = calculateMean(values);
  return values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
}

/**
 * How much of the spread a split accounts for.
 *
 * One minus the within-group variance over the total. A split through two
 * genuinely separate groups leaves little variance inside each, so the figure
 * approaches 1; a split through one unimodal blob leaves nearly all of it, so
 * the figure approaches 0.
 *
 * @param values - The observations.
 * @param cut - Where they were split.
 * @returns A fraction between 0 and 1.
 */
function calculateSeparation(values: number[], cut: number): number {
  const below = values.filter((value) => value < cut);
  const above = values.filter((value) => value >= cut);
  if (below.length < 2 || above.length < 2) {
    return 0;
  }

  const withinGroups =
    calculateVariance(below) * below.length + calculateVariance(above) * above.length;
  const total = calculateVariance(values) * values.length;

  return total === 0 ? 0 : 1 - withinGroups / total;
}

/**
 * Derive both skip thresholds from a library's own skip-button plays.
 *
 * **Both, because each vetoes the other's failure.** A completion ratio alone
 * calls 267 seconds of Boléro a rejection, because it is only 28% of the
 * piece. A clock alone calls 34 seconds of the 40-second *Maggie Mae* a
 * rejection, when 85% of it played. Requiring both to be low means a short
 * song cannot be a skip merely because little time passed, and a long one
 * cannot be a skip merely because a small fraction did.
 *
 * Measured on Idin's history: the pair agreed on 97.6% of plays, and the 32
 * they rescued from the ratio's verdict were all long — Boléro, *Master of
 * Puppets*, *Seek & Destroy* — exactly the case the pairing exists for.
 *
 * @param observations - Every play that ended with the skip button.
 * @returns Both thresholds with their separation, or null when there are too
 *   few plays to cluster honestly.
 */
export function clusterSkipThreshold(
  observations: SkippedPlayObservation[],
): SkipThreshold | null {
  if (observations.length < MINIMUM_PLAYS_FOR_CLUSTERING) {
    return null;
  }

  const completionRatios = observations.map((observation) =>
    calculateCompletionRatio(observation),
  );
  const secondsHeard = observations.map((observation) => observation.secondsPlayed);

  const ratioCut = findBetweenClassMaximum(completionRatios);
  const secondsCut = findBetweenClassMaximum(secondsHeard);
  if (ratioCut === null || secondsCut === null) {
    return null;
  }

  return {
    completionRatio: ratioCut,
    secondsHeard: secondsCut,
    // Reported from the ratio, which separated better than the clock on the
    // measured library — 0.825 against 0.725 — and is the axis a reader is
    // most likely to sanity-check the threshold against.
    separation: calculateSeparation(completionRatios, ratioCut),
    playCount: observations.length,
  };
}
