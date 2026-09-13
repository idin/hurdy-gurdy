import { describe, expect, test } from "vitest";

import {
  describeOperation,
  issueConfirmationToken,
  isValidConfirmation,
} from "../src/confirmation";

/**
 * These guard an operation with no undo, so the cases that matter are the
 * ones where a token must be *refused*: a different playlist, a different
 * track list, a different action, a stale token, a wrong secret. A test suite
 * that only proves the happy path would pass on a function that returned
 * `true` unconditionally.
 */

const SECRET = "test-cookie-encryption-key";
const NOW = Date.parse("2026-09-13T12:00:00Z");
const TEN_MINUTES = 10 * 60 * 1000;

describe("describeOperation", () => {
  test("the same operation described twice is identical", () => {
    expect(describeOperation("remove", "playlist-1", ["a", "b"])).toBe(
      describeOperation("remove", "playlist-1", ["a", "b"]),
    );
  });

  test("uri order does not change the operation", () => {
    // The same set of tracks in a different order is the same removal.
    // Failing a confirmation over ordering would be a refusal the caller
    // cannot see the reason for.
    expect(describeOperation("remove", "playlist-1", ["b", "a"])).toBe(
      describeOperation("remove", "playlist-1", ["a", "b"]),
    );
  });

  test("a different target is a different operation", () => {
    expect(describeOperation("remove", "playlist-1", ["a"])).not.toBe(
      describeOperation("remove", "playlist-2", ["a"]),
    );
  });

  test("a different track list is a different operation", () => {
    expect(describeOperation("remove", "playlist-1", ["a"])).not.toBe(
      describeOperation("remove", "playlist-1", ["a", "b"]),
    );
  });

  test("a different action is a different operation", () => {
    expect(describeOperation("remove", "playlist-1", ["a"])).not.toBe(
      describeOperation("add", "playlist-1", ["a"]),
    );
  });
});

describe("isValidConfirmation", () => {
  test("accepts the token it just issued", async () => {
    const operation = describeOperation("remove", "playlist-1", ["a", "b"]);
    const token = await issueConfirmationToken(SECRET, operation, NOW);

    expect(await isValidConfirmation(SECRET, operation, token, NOW)).toBe(true);
  });

  test("refuses a token issued for a different playlist", async () => {
    // The failure this whole module exists to prevent: an agent confirms a
    // removal from one playlist and the token empties another.
    const approved = describeOperation("remove", "playlist-1", ["a"]);
    const attempted = describeOperation("remove", "playlist-2", ["a"]);
    const token = await issueConfirmationToken(SECRET, approved, NOW);

    expect(await isValidConfirmation(SECRET, attempted, token, NOW)).toBe(false);
  });

  test("refuses a token issued for a different track list", async () => {
    const approved = describeOperation("remove", "playlist-1", ["a"]);
    const attempted = describeOperation("remove", "playlist-1", ["a", "b"]);
    const token = await issueConfirmationToken(SECRET, approved, NOW);

    expect(await isValidConfirmation(SECRET, attempted, token, NOW)).toBe(false);
  });

  test("accepts a token from the previous bucket, so a boundary is not a refusal", async () => {
    const operation = describeOperation("remove", "playlist-1", ["a"]);
    const token = await issueConfirmationToken(SECRET, operation, NOW);

    expect(
      await isValidConfirmation(SECRET, operation, token, NOW + TEN_MINUTES),
    ).toBe(true);
  });

  test("refuses a token older than two buckets", async () => {
    // An abandoned confirmation must not be replayable later against a
    // playlist whose contents have since changed.
    const operation = describeOperation("remove", "playlist-1", ["a"]);
    const token = await issueConfirmationToken(SECRET, operation, NOW);

    expect(
      await isValidConfirmation(SECRET, operation, token, NOW + 3 * TEN_MINUTES),
    ).toBe(false);
  });

  test("refuses a token derived with a different secret", async () => {
    const operation = describeOperation("remove", "playlist-1", ["a"]);
    const token = await issueConfirmationToken("someone-elses-secret", operation, NOW);

    expect(await isValidConfirmation(SECRET, operation, token, NOW)).toBe(false);
  });

  test("refuses an empty token", async () => {
    const operation = describeOperation("remove", "playlist-1", ["a"]);

    expect(await isValidConfirmation(SECRET, operation, "", NOW)).toBe(false);
  });

  test("refuses a made-up token of the right length", async () => {
    const operation = describeOperation("remove", "playlist-1", ["a"]);
    const real = await issueConfirmationToken(SECRET, operation, NOW);
    const forged = "0".repeat(real.length);

    expect(await isValidConfirmation(SECRET, operation, forged, NOW)).toBe(false);
  });
});
