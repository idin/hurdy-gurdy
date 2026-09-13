import { describe, expect, test } from "vitest";

import {
  describeOperation,
  issueConfirmationToken,
  isValidConfirmation,
} from "../../src/confirmation";

/**
 * The guard on the most destructive tool in the package.
 *
 * Moving a like unlikes the old track, and Spotify cannot undo that — the
 * original added-at date is gone even if the track is liked again. So the
 * cases worth testing are the ones where a token must be REFUSED: a different
 * set of moves, a set that changed between the dry run and the confirmation,
 * and a stale token.
 */

const SECRET = "test-cookie-encryption-key";
const NOW = Date.parse("2026-09-13T12:00:00Z");
const TEN_MINUTES = 10 * 60 * 1000;

/** Builds the operation string exactly as the tool does. */
function migrationOperation(moves: [string, string][]): string {
  return describeOperation(
    "migrate_to_better_versions",
    "library",
    moves.map(([from, to]) => `${from}>${to}`),
  );
}

describe("migration confirmation", () => {
  test("a token authorises the exact set it was issued for", async () => {
    const operation = migrationOperation([["spotify:track:orig", "spotify:track:rmx"]]);
    const token = await issueConfirmationToken(SECRET, operation, NOW);

    expect(await isValidConfirmation(SECRET, operation, token, NOW)).toBe(true);
  });

  test("a token does not authorise a different destination", async () => {
    // The failure this prevents: confirming a move to the 2018 remaster and
    // having the like land on something else entirely.
    const approved = migrationOperation([["spotify:track:orig", "spotify:track:rmx"]]);
    const attempted = migrationOperation([["spotify:track:orig", "spotify:track:other"]]);
    const token = await issueConfirmationToken(SECRET, approved, NOW);

    expect(await isValidConfirmation(SECRET, attempted, token, NOW)).toBe(false);
  });

  test("a token does not authorise moving a different track", async () => {
    const approved = migrationOperation([["spotify:track:a", "spotify:track:a2"]]);
    const attempted = migrationOperation([["spotify:track:b", "spotify:track:b2"]]);
    const token = await issueConfirmationToken(SECRET, approved, NOW);

    expect(await isValidConfirmation(SECRET, attempted, token, NOW)).toBe(false);
  });

  test("a token is refused when the set grew between the dry run and the call", async () => {
    // Something liked in between changes what would move. The user approved a
    // list they read; acting on a longer one would exceed that approval.
    const approved = migrationOperation([["spotify:track:a", "spotify:track:a2"]]);
    const grown = migrationOperation([
      ["spotify:track:a", "spotify:track:a2"],
      ["spotify:track:b", "spotify:track:b2"],
    ]);
    const token = await issueConfirmationToken(SECRET, approved, NOW);

    expect(await isValidConfirmation(SECRET, grown, token, NOW)).toBe(false);
  });

  test("a token is refused when the set shrank", async () => {
    const approved = migrationOperation([
      ["spotify:track:a", "spotify:track:a2"],
      ["spotify:track:b", "spotify:track:b2"],
    ]);
    const shrunk = migrationOperation([["spotify:track:a", "spotify:track:a2"]]);
    const token = await issueConfirmationToken(SECRET, approved, NOW);

    expect(await isValidConfirmation(SECRET, shrunk, token, NOW)).toBe(false);
  });

  test("the same moves in a different order still match", async () => {
    // Order is not part of the operation — the same moves are the same
    // approval, and failing over ordering would be a refusal with no reason
    // the caller can see.
    const first = migrationOperation([
      ["spotify:track:a", "spotify:track:a2"],
      ["spotify:track:b", "spotify:track:b2"],
    ]);
    const reordered = migrationOperation([
      ["spotify:track:b", "spotify:track:b2"],
      ["spotify:track:a", "spotify:track:a2"],
    ]);
    const token = await issueConfirmationToken(SECRET, first, NOW);

    expect(await isValidConfirmation(SECRET, reordered, token, NOW)).toBe(true);
  });

  test("an abandoned confirmation expires rather than lingering", async () => {
    const operation = migrationOperation([["spotify:track:a", "spotify:track:a2"]]);
    const token = await issueConfirmationToken(SECRET, operation, NOW);

    expect(
      await isValidConfirmation(SECRET, operation, token, NOW + 3 * TEN_MINUTES),
    ).toBe(false);
  });
});
