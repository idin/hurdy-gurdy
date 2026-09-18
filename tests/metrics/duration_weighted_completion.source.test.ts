/**
 * Tests for the duration-weighted completion score.
 *
 * The cases that matter are the endpoints — exponent 0 must recover the
 * unweighted score exactly, and exponent 1 must make the score proportional to
 * elapsed time. Those two are what justify calling this one metric rather than
 * two rival ones, so a test that only checked the 0.5 default would leave the
 * whole claim unverified.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LENGTH_WEIGHT_EXPONENT,
  calculateDurationWeightedCompletion,
  findMedianDuration,
} from "../../src/metrics/duration_weighted_completion";

/** The measured median of Idin's library, 2026-09-17. */
const MEDIAN_DURATION_SECONDS = 234.84;

describe("calculateDurationWeightedCompletion", () => {
  it("leaves a median-length song's score unchanged", () => {
    // The length factor is exactly 1 at the median, at every exponent. This is
    // why the exponent changes the tilt without changing the scale.
    const score = calculateDurationWeightedCompletion(
      { meanSquaredCompletionRatio: 0.5, durationSeconds: MEDIAN_DURATION_SECONDS },
      MEDIAN_DURATION_SECONDS,
    );

    expect(score).toBeCloseTo(0.5, 10);
  });

  it("recovers the unweighted score at exponent zero", () => {
    // Idin's point B in its pure form: length normalised away entirely.
    const score = calculateDurationWeightedCompletion(
      { meanSquaredCompletionRatio: 0.4, durationSeconds: 1_526 },
      MEDIAN_DURATION_SECONDS,
      0,
    );

    expect(score).toBeCloseTo(0.4, 10);
  });

  it("scales with elapsed time at exponent one", () => {
    // Idin's point A in its pure form. A song twice the median length scores
    // twice as much for the same completion.
    const atMedian = calculateDurationWeightedCompletion(
      { meanSquaredCompletionRatio: 0.5, durationSeconds: MEDIAN_DURATION_SECONDS },
      MEDIAN_DURATION_SECONDS,
      1,
    );
    const atDouble = calculateDurationWeightedCompletion(
      { meanSquaredCompletionRatio: 0.5, durationSeconds: MEDIAN_DURATION_SECONDS * 2 },
      MEDIAN_DURATION_SECONDS,
      1,
    );

    expect(atDouble / atMedian).toBeCloseTo(2, 10);
  });

  it("gives a four-times-longer song twice the weight at the default exponent", () => {
    // The square root, stated as the property that makes 0.5 the choice.
    const atMedian = calculateDurationWeightedCompletion(
      { meanSquaredCompletionRatio: 0.5, durationSeconds: MEDIAN_DURATION_SECONDS },
      MEDIAN_DURATION_SECONDS,
    );
    const atQuadruple = calculateDurationWeightedCompletion(
      { meanSquaredCompletionRatio: 0.5, durationSeconds: MEDIAN_DURATION_SECONDS * 4 },
      MEDIAN_DURATION_SECONDS,
    );

    expect(atQuadruple / atMedian).toBeCloseTo(2, 10);
  });

  it("sits between the two endpoints for a long song", () => {
    // The whole justification for an exponent: 0.5 is genuinely intermediate,
    // not a relabelling of one of the ends.
    const song = { meanSquaredCompletionRatio: 0.4, durationSeconds: 1_526 };
    const unweighted = calculateDurationWeightedCompletion(song, MEDIAN_DURATION_SECONDS, 0);
    const middle = calculateDurationWeightedCompletion(song, MEDIAN_DURATION_SECONDS);
    const proportional = calculateDurationWeightedCompletion(song, MEDIAN_DURATION_SECONDS, 1);

    expect(middle).toBeGreaterThan(unweighted);
    expect(middle).toBeLessThan(proportional);
  });

  it("penalises a song shorter than the median", () => {
    const score = calculateDurationWeightedCompletion(
      { meanSquaredCompletionRatio: 1, durationSeconds: MEDIAN_DURATION_SECONDS / 4 },
      MEDIAN_DURATION_SECONDS,
    );

    expect(score).toBeCloseTo(0.5, 10);
  });

  it("returns zero when the library has no median", () => {
    expect(
      calculateDurationWeightedCompletion(
        { meanSquaredCompletionRatio: 1, durationSeconds: 200 },
        0,
      ),
    ).toBe(0);
  });

  it("returns zero when the song's length is unknown", () => {
    expect(
      calculateDurationWeightedCompletion(
        { meanSquaredCompletionRatio: 1, durationSeconds: 0 },
        MEDIAN_DURATION_SECONDS,
      ),
    ).toBe(0);
  });

  it("defaults to the square root", () => {
    expect(DEFAULT_LENGTH_WEIGHT_EXPONENT).toBe(0.5);
  });
});

describe("findMedianDuration", () => {
  it("takes the middle value of an odd-length list", () => {
    expect(findMedianDuration([300, 100, 200])).toBe(200);
  });

  it("averages the two middle values of an even-length list", () => {
    expect(findMedianDuration([100, 200, 300, 400])).toBe(250);
  });

  it("is unmoved by a handful of very long songs", () => {
    // Why median rather than mean: three 25-minute pieces would drag a mean
    // far above anything typical, and every ordinary song would then look
    // short by comparison.
    const ordinary = [200, 210, 220, 230, 240];
    const withEpics = [...ordinary, 1_500, 1_500, 1_500];

    expect(findMedianDuration(ordinary)).toBe(220);
    expect(findMedianDuration(withEpics)).toBe(235);
  });

  it("ignores unknown lengths rather than counting them as zero", () => {
    expect(findMedianDuration([0, 0, 200, 300, 400])).toBe(300);
  });

  it("returns null when nothing has a known length", () => {
    expect(findMedianDuration([])).toBeNull();
    expect(findMedianDuration([0, 0])).toBeNull();
  });
});
