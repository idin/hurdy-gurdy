import { describe, expect, test } from "vitest";

import {
  isDeliberateSkip,
  readExtendedHistory,
  summariseExtendedPlays,
  type ExtendedPlay,
} from "../../src/export/read_extended_history";

/**
 * Field names and values copied from Idin's own extended history, 2026-09-14.
 *
 * The distinction these tests protect is between a track the listener
 * *rejected* and one that merely stopped. Both set `skipped`, and conflating
 * them would turn a logout into an opinion about the music.
 */

function play(overrides: Partial<ExtendedPlay> = {}): ExtendedPlay {
  return {
    ts: "2026-01-01T00:33:40Z",
    ms_played: 1480,
    spotify_track_uri: "spotify:track:3k8qSv5e8ALW6tA9cpY9mm",
    master_metadata_track_name: "Ode To My Family - 2025 Remastered",
    master_metadata_album_artist_name: "The Cranberries",
    master_metadata_album_album_name: "No Need To Argue",
    reason_start: "clickrow",
    reason_end: "trackdone",
    skipped: false,
    shuffle: false,
    platform: "android",
    offline: false,
    incognito_mode: false,
    ...overrides,
  };
}

describe("isDeliberateSkip", () => {
  test("the skip button is a rejection", () => {
    // 22,809 of these in Idin's history — the strongest negative signal the
    // project has, and the one a lazy catalogue otherwise cannot produce.
    expect(isDeliberateSkip(play({ reason_end: "fwdbtn" }))).toBe(true);
  });

  test("stopping playback is a rejection", () => {
    expect(isDeliberateSkip(play({ reason_end: "endplay" }))).toBe(true);
  });

  test("a track playing out is not", () => {
    expect(isDeliberateSkip(play({ reason_end: "trackdone" }))).toBe(false);
  });

  test("a logout is not a rejection, even when skipped is true", () => {
    // The distinction that matters. A session ending says nothing about the
    // music, and both set the skipped flag.
    expect(isDeliberateSkip(play({ reason_end: "logout", skipped: true }))).toBe(false);
  });

  test("an unexpected exit is not a rejection", () => {
    expect(
      isDeliberateSkip(play({ reason_end: "unexpected-exit-while-paused", skipped: true })),
    ).toBe(false);
  });
});

describe("summariseExtendedPlays", () => {
  test("counts completions, rejections and neither, separately", () => {
    const summaries = summariseExtendedPlays([
      play({ reason_end: "trackdone" }),
      play({ reason_end: "trackdone" }),
      play({ reason_end: "fwdbtn" }),
      play({ reason_end: "logout" }),
    ]);

    const summary = summaries.get("spotify:track:3k8qSv5e8ALW6tA9cpY9mm");
    expect(summary?.completedCount).toBe(2);
    expect(summary?.skippedCount).toBe(1);
    expect(summary?.otherCount).toBe(1);
  });

  test("keys on the track URI, not on names", () => {
    // The whole reason this export supersedes the other one: exact identity
    // rather than a name match that fails on a remaster suffix.
    const summaries = summariseExtendedPlays([
      play({ master_metadata_track_name: "Ode To My Family" }),
      play({ master_metadata_track_name: "Ode To My Family - 2025 Remastered" }),
    ]);

    expect(summaries.size).toBe(1);
  });

  test("two different tracks stay separate", () => {
    const summaries = summariseExtendedPlays([
      play({ spotify_track_uri: "spotify:track:a" }),
      play({ spotify_track_uri: "spotify:track:b" }),
    ]);

    expect(summaries.size).toBe(2);
  });

  test("keeps the most recent play, whatever the file order", () => {
    const summaries = summariseExtendedPlays([
      play({ ts: "2026-03-05T22:15:00Z" }),
      play({ ts: "2026-01-01T00:33:40Z" }),
    ]);

    expect(summaries.get("spotify:track:3k8qSv5e8ALW6tA9cpY9mm")?.lastPlayed).toBe(
      "2026-03-05T22:15:00Z",
    );
  });

  test("counts how often a track arrived through shuffle", () => {
    // Rejecting something offered differs from rejecting something queued.
    const summaries = summariseExtendedPlays([
      play({ shuffle: true }),
      play({ shuffle: true }),
      play({ shuffle: false }),
    ]);

    expect(summaries.get("spotify:track:3k8qSv5e8ALW6tA9cpY9mm")?.shuffledCount).toBe(2);
  });

  test("skips podcast and audiobook rows, which share the file", () => {
    // Those carry no track URI, and counting them would key on null.
    const summaries = summariseExtendedPlays([
      play({ spotify_track_uri: null }),
      play(),
    ]);

    expect(summaries.size).toBe(1);
  });
});

describe("readExtendedHistory", () => {
  test("parses a year file", () => {
    expect(readExtendedHistory(JSON.stringify([play()]))).toHaveLength(1);
  });
});
