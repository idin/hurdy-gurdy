/**
 * Tests for the clustered skip threshold.
 *
 * The check that matters is not "does it return a number" — Otsu always
 * returns a number. It is whether the `separation` figure distinguishes a
 * distribution that genuinely has two groups from one that does not, because
 * that figure is the only thing standing between a derived threshold and a
 * confidently-reported artefact.
 */

import { describe, expect, it } from "vitest";
import {
  clusterSkipThreshold,
  type SkippedPlayObservation,
} from "../../src/metrics/cluster_skip_threshold";

/** A 235-second song, the measured median length of Idin's library. */
const MEDIAN_DURATION_SECONDS = 235;

/** Build plays at a given completion ratio. */
function buildPlaysAtRatio(ratio: number, count: number): SkippedPlayObservation[] {
  return Array.from({ length: count }, () => ({
    secondsPlayed: MEDIAN_DURATION_SECONDS * ratio,
    durationSeconds: MEDIAN_DURATION_SECONDS,
  }));
}

describe("clusterSkipThreshold", () => {
  it("finds the break between two genuinely separate groups", () => {
    // The observed shape: a dense cluster of near-instant skips and a sparser
    // one of plays that ran most of the way.
    const observations = [
      ...buildPlaysAtRatio(0.01, 800),
      ...buildPlaysAtRatio(0.03, 200),
      ...buildPlaysAtRatio(0.62, 100),
      ...buildPlaysAtRatio(0.7, 100),
    ];

    const threshold = clusterSkipThreshold(observations);

    expect(threshold).not.toBeNull();
    expect(threshold!.completionRatio).toBeGreaterThan(0.03);
    expect(threshold!.completionRatio).toBeLessThan(0.62);
    // Two well-separated groups leave little variance inside each.
    expect(threshold!.separation).toBeGreaterThan(0.8);
  });

  it("reports low separation when there is no real division", () => {
    // Uniformly spread plays have no two groups to find. Otsu still returns a
    // cut — this is the case that would go unnoticed without the separation
    // figure, and reporting it confidently is the failure being guarded.
    const observations = Array.from({ length: 1_000 }, (_, index) => ({
      secondsPlayed: MEDIAN_DURATION_SECONDS * (index / 1_000),
      durationSeconds: MEDIAN_DURATION_SECONDS,
    }));

    const threshold = clusterSkipThreshold(observations);

    expect(threshold).not.toBeNull();
    expect(threshold!.separation).toBeLessThan(0.8);
  });

  it("refuses to cluster too few plays", () => {
    expect(clusterSkipThreshold(buildPlaysAtRatio(0.01, 50))).toBeNull();
  });

  it("returns null when every play is identical", () => {
    // No spread, so no cut exists. Must not invent one.
    expect(clusterSkipThreshold(buildPlaysAtRatio(0.5, 200))).toBeNull();
  });

  it("derives a seconds threshold alongside the ratio", () => {
    const observations = [
      ...buildPlaysAtRatio(0.01, 800),
      ...buildPlaysAtRatio(0.7, 200),
    ];

    const threshold = clusterSkipThreshold(observations);

    expect(threshold).not.toBeNull();
    expect(threshold!.secondsHeard).toBeGreaterThan(0);
    expect(threshold!.secondsHeard).toBeLessThan(MEDIAN_DURATION_SECONDS);
  });

  it("reports how many plays the threshold rests on", () => {
    const threshold = clusterSkipThreshold([
      ...buildPlaysAtRatio(0.01, 800),
      ...buildPlaysAtRatio(0.7, 200),
    ]);

    expect(threshold!.playCount).toBe(1_000);
  });
});
