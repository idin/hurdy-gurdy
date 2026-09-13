import { describe, expect, test } from "vitest";

import {
  CACHE_TIME_TO_LIVE_MILLISECONDS,
  buildCacheKey,
  expiryFrom,
  lookUpCacheEntry,
  type CacheEntry,
} from "../../src/cache/cache_entry";

/**
 * The sliding rule is the whole point of this module, so these cover the
 * boundary rather than only the comfortable middle: an entry expiring exactly
 * now, an entry one millisecond either side of it, and the renewal actually
 * moving the expiry rather than merely reporting the entry as fresh.
 *
 * A cache that reports "fresh" without renewing would pass a naive test and
 * then expire entries that are in constant use.
 */

const NOW = Date.parse("2026-09-13T12:00:00Z");

function entryExpiringAt(expiresAt: number): CacheEntry {
  return {
    key: "spotify:getLikedTracks",
    payload: '{"items":[]}',
    etag: 'W/"abc"',
    total: 40,
    expiresAt,
  };
}

describe("buildCacheKey", () => {
  test("separates two providers answering the same question", () => {
    const spotify = buildCacheKey("spotify", "getLikedTracks", { cursor: "0" });
    const youtube = buildCacheKey("ytmusic", "getLikedTracks", { cursor: "0" });
    expect(spotify).not.toBe(youtube);
  });

  test("separates two pages of the same call", () => {
    expect(buildCacheKey("spotify", "getLikedTracks", { cursor: "0" })).not.toBe(
      buildCacheKey("spotify", "getLikedTracks", { cursor: "50" }),
    );
  });

  test("is order-independent, so callers cannot accidentally split an entry", () => {
    expect(buildCacheKey("spotify", "search", { query: "queen", limit: 10 })).toBe(
      buildCacheKey("spotify", "search", { limit: 10, query: "queen" }),
    );
  });

  test("omits undefined parameters rather than keying on the word undefined", () => {
    expect(buildCacheKey("spotify", "getLikedTracks", { cursor: undefined })).toBe(
      buildCacheKey("spotify", "getLikedTracks", {}),
    );
  });
});

describe("lookUpCacheEntry", () => {
  test("reports a missing entry", () => {
    expect(lookUpCacheEntry(null, NOW)).toEqual({ state: "missing" });
  });

  test("reads an unexpired entry as fresh", () => {
    const result = lookUpCacheEntry(entryExpiringAt(NOW + 1000), NOW);
    expect(result.state).toBe("fresh");
  });

  test("renews the expiry when read, not merely reports fresh", () => {
    // The failure this catches: an entry in daily use expiring anyway,
    // because reading it never pushed the expiry back.
    const result = lookUpCacheEntry(entryExpiringAt(NOW + 1000), NOW);
    if (result.state !== "fresh") {
      throw new Error(`expected fresh, got ${result.state}`);
    }
    expect(result.entry.expiresAt).toBe(NOW + CACHE_TIME_TO_LIVE_MILLISECONDS);
  });

  test("keeps the payload and etag intact when renewing", () => {
    const result = lookUpCacheEntry(entryExpiringAt(NOW + 1000), NOW);
    if (result.state !== "fresh") {
      throw new Error(`expected fresh, got ${result.state}`);
    }
    expect(result.entry.payload).toBe('{"items":[]}');
    expect(result.entry.etag).toBe('W/"abc"');
    expect(result.entry.total).toBe(40);
  });

  test("reads an expired entry as stale rather than missing", () => {
    // Stale and missing are different: stale carries an etag, which makes
    // revalidation free. Collapsing them would refetch bodies needlessly.
    const result = lookUpCacheEntry(entryExpiringAt(NOW - 1000), NOW);
    expect(result.state).toBe("stale");
  });

  test("treats an entry expiring exactly now as stale", () => {
    // The boundary. Off-by-one here serves a just-expired entry as fresh.
    expect(lookUpCacheEntry(entryExpiringAt(NOW), NOW).state).toBe("stale");
  });

  test("treats an entry expiring one millisecond from now as fresh", () => {
    expect(lookUpCacheEntry(entryExpiringAt(NOW + 1), NOW).state).toBe("fresh");
  });

  test("does not renew a stale entry — revalidation must decide that", () => {
    const result = lookUpCacheEntry(entryExpiringAt(NOW - 1000), NOW);
    if (result.state !== "stale") {
      throw new Error(`expected stale, got ${result.state}`);
    }
    expect(result.entry.expiresAt).toBe(NOW - 1000);
  });
});

describe("expiryFrom", () => {
  test("is 66 days out, the agreed time to live", () => {
    expect(expiryFrom(NOW) - NOW).toBe(66 * 24 * 60 * 60 * 1000);
  });
});
