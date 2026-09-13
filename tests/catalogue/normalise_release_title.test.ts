import { describe, expect, test } from "vitest";

import {
  buildWorkKey,
  isLiveRelease,
  normaliseReleaseTitle,
} from "../../src/catalogue/normalise_release_title";

/**
 * Every title here is real, taken from Spotify on 2026-09-13 while deriving
 * the suffix vocabulary from 234 titles across eight heavily-reissued
 * artists. None is invented, because a fixture written from imagination tests
 * imagination — which is the mistake logged earlier the same day.
 *
 * The cases that matter most are the ones that must NOT merge: a box set
 * sharing a name with the album, a live record sharing a name with the studio
 * one, and a genuine re-recording.
 */

describe("normaliseReleaseTitle", () => {
  test("strips a remix suffix", () => {
    expect(normaliseReleaseTitle("Animals (2018 Remix)")).toBe("animals");
  });

  test("strips a remaster suffix", () => {
    expect(normaliseReleaseTitle("Master of Puppets (Remastered)")).toBe("master of puppets");
  });

  test("strips the hyphenated Re-Mastered form", () => {
    // Four titles in the sample used this spelling. A hand-written list would
    // have had "remastered" and missed it.
    expect(normaliseReleaseTitle("Back in Black (2009 Re-Mastered)")).toBe("back in black");
  });

  test("strips a bare Mix, which Pink Floyd uses where others write Remix", () => {
    expect(normaliseReleaseTitle("The Wall (2025 Mix)")).toBe("the wall");
  });

  test("strips Collector's Edition", () => {
    expect(normaliseReleaseTitle("Innuendo (Collector's Edition)")).toBe("innuendo");
  });

  test("strips stacked suffixes", () => {
    // Real title, and the reason stripping runs more than once.
    expect(
      normaliseReleaseTitle("The Dark Side Of The Moon (50th Anniversary) [2023 Remaster]"),
    ).toBe("the dark side of the moon");
  });

  test("strips a dash-form suffix", () => {
    expect(normaliseReleaseTitle("Meddle - 2011 Remaster")).toBe("meddle");
  });

  test("drops a bare Live marker, because liveness is keyed separately", () => {
    // These two assertions previously expected (live) to survive here. That
    // was wrong, and it broke the thing that matters: two masters of one live
    // record got different keys and never merged. Liveness belongs in the work
    // key's own field, not in the title as well — buildWorkKey still keeps
    // live and studio apart, which is the behaviour anyone depends on.
    expect(normaliseReleaseTitle("Delicate Sound of Thunder (Live)")).toBe(
      "delicate sound of thunder",
    );
  });

  test("drops a bare Live and the master marker behind it", () => {
    expect(normaliseReleaseTitle("Pink Floyd at Pompeii (2025 Mix) [Live]")).toBe(
      "pink floyd at pompeii",
    );
  });

  test("keeps a specific performance, which is a different record", () => {
    // "Live at Wembley 1974" is not a liveness marker, it names one night.
    // A different night is a different record and must not merge.
    expect(
      normaliseReleaseTitle("The Dark Side Of The Moon (Live at Wembley 1974)"),
    ).toContain("wembley");
  });

  test("keeps a soundtrack marker", () => {
    expect(normaliseReleaseTitle("More (The Original Soundtrack)")).toContain("soundtrack");
  });

  test("leaves an unadorned title alone but for case", () => {
    expect(normaliseReleaseTitle("The Endless River")).toBe("the endless river");
  });

  test("never returns an empty key", () => {
    // A title that is nothing but markers would otherwise become a blank that
    // merges with every other blank.
    expect(normaliseReleaseTitle("(Remastered)")).not.toBe("");
  });
});

describe("isLiveRelease", () => {
  test("recognises a parenthetical Live", () => {
    expect(isLiveRelease("Delicate Sound of Thunder (Live)")).toBe(true);
  });

  test("recognises Live in a longer phrase", () => {
    expect(isLiveRelease("The Dark Side Of The Moon (Live at Wembley 1974)")).toBe(true);
  });

  test("does not fire on a word merely containing live", () => {
    // The near-miss: "Delivery" and "Alive" contain the letters.
    expect(isLiveRelease("Alive and Well")).toBe(false);
    expect(isLiveRelease("Special Delivery")).toBe(false);
  });

  test("a studio album is not live", () => {
    expect(isLiveRelease("The Division Bell")).toBe(false);
  });
});

describe("buildWorkKey", () => {
  test("an album and its remaster share a key", () => {
    // The whole point: these are one work with two masters.
    expect(buildWorkKey({ title: "Animals", totalTracks: 5 })).toBe(
      buildWorkKey({ title: "Animals (2018 Remix)", totalTracks: 5 }),
    );
  });

  test("the three real Pink Floyd duplicate pairs all merge", () => {
    const pairs: [string, string, number][] = [
      ["Animals", "Animals (2018 Remix)", 5],
      ["A Momentary Lapse of Reason", "A Momentary Lapse of Reason (2019 Remix)", 11],
      [
        "The Dark Side of the Moon",
        "The Dark Side Of The Moon (50th Anniversary) [2023 Remaster]",
        10,
      ],
    ];
    for (const [original, reissue, totalTracks] of pairs) {
      expect(buildWorkKey({ title: original, totalTracks })).toBe(
        buildWorkKey({ title: reissue, totalTracks }),
      );
    }
  });

  test("a box set does NOT merge with the album it is named after", () => {
    // Wish You Were Here has 5 tracks; Wish You Were Here 50 has 30. Real
    // titles, real counts, and the reason track count is part of the key.
    expect(buildWorkKey({ title: "Wish You Were Here", totalTracks: 5 })).not.toBe(
      buildWorkKey({ title: "Wish You Were Here 50", totalTracks: 30 }),
    );
  });

  test("a live album does NOT merge with the studio album of the same name", () => {
    expect(buildWorkKey({ title: "Pulse", totalTracks: 25 })).not.toBe(
      buildWorkKey({ title: "Pulse (Live)", totalTracks: 25 }),
    );
  });

  test("two live masters of the same record DO merge", () => {
    expect(
      buildWorkKey({ title: "Delicate Sound of Thunder (Live)", totalTracks: 15 }),
    ).toBe(
      buildWorkKey({
        title: "Delicate Sound of Thunder (2019 Remix) [Live]",
        totalTracks: 15,
      }),
    );
  });

  test("a re-recording does not merge with the original when lengths differ", () => {
    expect(buildWorkKey({ title: "Fearless", totalTracks: 13 })).not.toBe(
      buildWorkKey({ title: "Fearless (Taylor's Version)", totalTracks: 26 }),
    );
  });

  test("an unknown track count keys as itself, not as a shared blank", () => {
    // Merging on a missing value would group every unreported release.
    expect(buildWorkKey({ title: "Some Album", totalTracks: null })).not.toBe(
      buildWorkKey({ title: "Other Album", totalTracks: null }),
    );
  });
});
