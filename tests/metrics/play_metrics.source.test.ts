/**
 * Tests for the per-play metrics.
 *
 * Every case here is a real play shape observed in Idin's history rather than
 * a made-up number: the near-zero skip, the late skip on an outro, the long
 * song abandoned mid-way, the short song almost finished, and the overrun row
 * that logs more time than the track has.
 *
 * The near-miss cases are the point. A skip rule tested only on "2 seconds of
 * a 4-minute song" proves nothing about whether it discriminates — which is
 * the only thing a rule is for.
 */

import { describe, expect, it } from "vitest";
import {
  calculateCompletionRatio,
  checkPlayWasChosen,
  checkPlayWasSkipped,
} from "../../src/metrics/play_metrics";
import type { SkipThreshold } from "../../src/metrics/cluster_skip_threshold";

/** The thresholds clustered from Idin's 12,031 skip presses on 2026-09-15. */
const MEASURED_THRESHOLD: SkipThreshold = {
  completionRatio: 0.33,
  secondsHeard: 103.5,
  separation: 0.825,
  playCount: 12_031,
};

describe("calculateCompletionRatio", () => {
  it("reports the share of the song that played", () => {
    expect(calculateCompletionRatio({ secondsPlayed: 100, durationSeconds: 200 })).toBe(0.5);
  });

  it("clamps a play that overruns the track length", () => {
    // Observed: 787 seconds logged against a 261-second song, 13.56% of plays
    // overrun to some degree. Unclamped and squared, one such row would
    // outweigh three complete listens.
    expect(calculateCompletionRatio({ secondsPlayed: 787, durationSeconds: 261 })).toBe(1);
  });

  it("returns zero when the duration is unknown", () => {
    expect(calculateCompletionRatio({ secondsPlayed: 100, durationSeconds: 0 })).toBe(0);
  });
});

describe("checkPlayWasSkipped", () => {
  it("calls a two-second skip a rejection", () => {
    // The median skip in the history: 1.9 seconds.
    expect(
      checkPlayWasSkipped(
        { secondsPlayed: 2, durationSeconds: 235, reasonEnd: "fwdbtn" },
        MEASURED_THRESHOLD,
      ),
    ).toBe(true);
  });

  it("does not call a completed play a rejection", () => {
    expect(
      checkPlayWasSkipped(
        { secondsPlayed: 235, durationSeconds: 235, reasonEnd: "trackdone" },
        MEASURED_THRESHOLD,
      ),
    ).toBe(false);
  });

  it("does not call a skip on the outro a rejection", () => {
    // 1.1% of skip presses land above 90% of the song. The button was pressed,
    // but the song was heard — the ratio vetoes it.
    expect(
      checkPlayWasSkipped(
        { secondsPlayed: 230, durationSeconds: 235, reasonEnd: "fwdbtn" },
        MEASURED_THRESHOLD,
      ),
    ).toBe(false);
  });

  it("does not call a long song abandoned mid-way a rejection", () => {
    // Boléro: 267 seconds of 933. Only 28.6% played, so the ratio alone says
    // skip — but four and a half minutes were heard, and the clock vetoes it.
    // This is the case the paired thresholds exist for.
    expect(
      checkPlayWasSkipped(
        { secondsPlayed: 267, durationSeconds: 933, reasonEnd: "fwdbtn" },
        MEASURED_THRESHOLD,
      ),
    ).toBe(false);
  });

  it("does not call a nearly-finished short song a rejection", () => {
    // Maggie Mae: 34 seconds of 40, so 84.7% played. Under the 103.5-second
    // clock, which alone would call it a skip — the ratio vetoes it.
    expect(
      checkPlayWasSkipped(
        { secondsPlayed: 34, durationSeconds: 40, reasonEnd: "fwdbtn" },
        MEASURED_THRESHOLD,
      ),
    ).toBe(false);
  });

  it("ignores a play that ended by logout rather than the skip button", () => {
    // 19,684 plays ended some other way. A logout expresses no opinion about
    // the song and must not count against it.
    expect(
      checkPlayWasSkipped(
        { secondsPlayed: 2, durationSeconds: 235, reasonEnd: "logout" },
        MEASURED_THRESHOLD,
      ),
    ).toBe(false);
  });

  it("ignores endplay, which is leaving rather than rejecting", () => {
    expect(
      checkPlayWasSkipped(
        { secondsPlayed: 2, durationSeconds: 235, reasonEnd: "endplay" },
        MEASURED_THRESHOLD,
      ),
    ).toBe(false);
  });
});

describe("checkPlayWasChosen", () => {
  it("counts a track clicked from a list", () => {
    expect(checkPlayWasChosen("clickrow")).toBe(true);
  });

  it("counts a play started from another device", () => {
    expect(checkPlayWasChosen("remote")).toBe(true);
  });

  it("does not count a track that followed the previous one", () => {
    expect(checkPlayWasChosen("trackdone")).toBe(false);
  });

  it("does not count a track reached by skipping the previous one", () => {
    // The trap: fwdbtn as a START reason means the PREVIOUS track was
    // rejected and this one was merely next. 39.5% of plays begin this way,
    // so reading it as a choice would misclassify most of the history.
    expect(checkPlayWasChosen("fwdbtn")).toBe(false);
  });

  it("does not count a missing reason", () => {
    expect(checkPlayWasChosen(null)).toBe(false);
  });
});
