import { describe, expect, test } from "vitest";

import type { CacheEntry } from "../../src/cache/cache_entry";
import {
  buildConditionalHeaders,
  canRevalidateCheaply,
  readConditionalVerdict,
  readTotalVerdict,
} from "../../src/cache/freshness_check";

/**
 * The dangerous verdict is `unchanged`, because it serves cached data. Every
 * case below that could wrongly produce it is covered: a missing ETag, a
 * missing total, a total that is absent now rather than then. A check that
 * says "unchanged" when it proved nothing is worse than no check, since the
 * staleness then never expires until the TTL catches it.
 */

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    key: "spotify:getFollowedArtists",
    payload: '{"items":[]}',
    etag: 'W/"abc"',
    total: 75,
    expiresAt: 0,
    ...overrides,
  };
}

describe("buildConditionalHeaders", () => {
  test("offers the stored etag", () => {
    expect(buildConditionalHeaders(entry())).toEqual({ "If-None-Match": 'W/"abc"' });
  });

  test("sends nothing when there is no etag to offer", () => {
    expect(buildConditionalHeaders(entry({ etag: null }))).toEqual({});
  });
});

describe("readConditionalVerdict", () => {
  test("304 means the cached payload is still exact", () => {
    expect(readConditionalVerdict(entry(), 304)).toEqual({ state: "unchanged" });
  });

  test("200 means it changed", () => {
    expect(readConditionalVerdict(entry(), 200)).toEqual({
      state: "changed",
      reason: "etag-mismatch",
    });
  });

  test("a 200 with no etag stored proves nothing, so it counts as changed", () => {
    // The trap: without an If-None-Match header there was no conditional
    // request, so a 200 is an ordinary response and not evidence of anything.
    expect(readConditionalVerdict(entry({ etag: null }), 200)).toEqual({
      state: "changed",
      reason: "no-etag-stored",
    });
  });

  test("even a 304 is not trusted when no etag was sent", () => {
    // A provider answering 304 to an unconditional request is malformed, and
    // trusting it would serve cached data on the strength of a bug.
    expect(readConditionalVerdict(entry({ etag: null }), 304).state).toBe("changed");
  });
});

describe("readTotalVerdict", () => {
  test("an unchanged total means the collection looks unchanged", () => {
    expect(readTotalVerdict(entry({ total: 75 }), 75)).toEqual({ state: "unchanged" });
  });

  test("a grown total means something was added", () => {
    // The case that motivates this signal: a newly followed artist, noticed
    // without walking the whole list.
    expect(readTotalVerdict(entry({ total: 74 }), 75)).toEqual({
      state: "changed",
      reason: "total-changed",
    });
  });

  test("a shrunk total means something was removed", () => {
    expect(readTotalVerdict(entry({ total: 75 }), 74).state).toBe("changed");
  });

  test("a total that was never stored proves nothing", () => {
    expect(readTotalVerdict(entry({ total: null }), 75)).toEqual({
      state: "changed",
      reason: "no-total-stored",
    });
  });

  test("a total not reported now proves nothing either", () => {
    // Asymmetric with the case above, and both directions matter: unknown is
    // not the same as unchanged, whichever side the unknown is on.
    expect(readTotalVerdict(entry({ total: 75 }), null).state).toBe("changed");
  });

  test("zero is a real total, not a missing one", () => {
    // The near-miss: a falsy check instead of a null check would treat an
    // empty collection as unknown and refetch it forever.
    expect(readTotalVerdict(entry({ total: 0 }), 0)).toEqual({ state: "unchanged" });
  });
});

describe("canRevalidateCheaply", () => {
  test("an etag is enough", () => {
    expect(canRevalidateCheaply(entry({ etag: 'W/"x"', total: null }))).toBe(true);
  });

  test("a total is enough", () => {
    expect(canRevalidateCheaply(entry({ etag: null, total: 10 }))).toBe(true);
  });

  test("neither means a full fetch is no more expensive", () => {
    expect(canRevalidateCheaply(entry({ etag: null, total: null }))).toBe(false);
  });

  test("a total of zero still counts as something to check against", () => {
    expect(canRevalidateCheaply(entry({ etag: null, total: 0 }))).toBe(true);
  });
});
