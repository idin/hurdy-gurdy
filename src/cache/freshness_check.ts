/**
 * Deciding whether cached data is still correct, as cheaply as possible.
 *
 * Three signals, cheapest first. Each catches something the one before it
 * misses, and none of them catches everything:
 *
 * 1. **ETag.** A conditional request answered `304 Not Modified` proves the
 *    cached payload is still exact, costs no quota, and carries no body.
 *    Verified against Spotify's live API on 2026-09-13: `/me/playlists`
 *    returns an ETag, and the same request carrying it as `If-None-Match`
 *    returns 304. The whole design leans on this, so it was tested before it
 *    was written down.
 * 2. **Collection totals.** `GET /me/following?limit=1` reports `total`
 *    without fetching any pages, so one request says whether a collection
 *    gained or lost members. This is what notices a newly followed artist
 *    without walking the list.
 * 3. **Sliding TTL.** The floor, in `cache_entry.ts`. Nothing is trusted
 *    forever even when no signal says it changed.
 *
 * **What none of them catch:** a same-size swap — unfollowing one artist and
 * following another — leaves the total identical, and a change on a page
 * nobody reads is unnoticed until someone reads it. Spotify publishes no
 * change feed and no modified-since parameter, so there is no cheaper signal
 * to add. The TTL is the backstop, deliberately.
 */

import type { CacheEntry } from "./cache_entry";

/** What a freshness check concluded, and what the caller should do next. */
export type FreshnessVerdict =
  /** Nothing changed. Renew the entry's expiry and serve what is cached. */
  | { state: "unchanged" }
  /** Something changed, or nothing could be proven. Fetch and replace. */
  | { state: "changed"; reason: FreshnessReason };

/**
 * Why a cached entry is being refetched.
 *
 * Carried rather than discarded because "the total moved from 74 to 75" and
 * "there was no ETag to ask with" are different situations, and a caller
 * debugging unexpected refetches needs to tell them apart.
 */
export type FreshnessReason =
  | "etag-mismatch"
  | "no-etag-stored"
  | "total-changed"
  | "no-total-stored";

/** HTTP status meaning the conditional request matched — body unchanged, not sent. */
const NOT_MODIFIED = 304;

/**
 * The header a conditional request sends, carrying the stored ETag.
 *
 * @param entry - The cached entry whose ETag should be offered.
 * @returns Headers to merge into the request, empty when there is no ETag.
 */
export function buildConditionalHeaders(entry: CacheEntry): Record<string, string> {
  return entry.etag === null ? {} : { "If-None-Match": entry.etag };
}

/**
 * Read a conditional response's verdict.
 *
 * @param entry - The entry that was revalidated.
 * @param status - The HTTP status the provider answered with.
 * @returns Whether the cached payload is still good.
 */
export function readConditionalVerdict(
  entry: CacheEntry,
  status: number,
): FreshnessVerdict {
  if (entry.etag === null) {
    // Nothing was asked, so nothing was proven. A 200 here is just a normal
    // response, not evidence of a change.
    return { state: "changed", reason: "no-etag-stored" };
  }
  return status === NOT_MODIFIED
    ? { state: "unchanged" }
    : { state: "changed", reason: "etag-mismatch" };
}

/**
 * Compare a collection's current size against what was cached.
 *
 * Used where an ETag is unavailable or where the question is about the
 * *collection* rather than one page of it — "have I followed anyone new"
 * rather than "is page three still the same".
 *
 * @param entry - The cached entry, whose `total` was stored alongside it.
 * @param currentTotal - The provider's total right now, or null when it
 *   reported none.
 * @returns Whether the collection looks unchanged.
 */
export function readTotalVerdict(
  entry: CacheEntry,
  currentTotal: number | null,
): FreshnessVerdict {
  if (entry.total === null || currentTotal === null) {
    // A total that was never stored, or is not being reported now, proves
    // nothing either way — and treating "unknown" as "unchanged" would serve
    // stale data on a guess.
    return { state: "changed", reason: "no-total-stored" };
  }
  return entry.total === currentTotal
    ? { state: "unchanged" }
    : { state: "changed", reason: "total-changed" };
}

/**
 * Whether a stale entry can be revalidated cheaply at all.
 *
 * A caller with no ETag and no stored total has nothing to ask with, so
 * revalidation would cost a full fetch either way — in which case fetching
 * directly is simpler and no more expensive.
 *
 * @param entry - The entry in question.
 * @returns True when a cheap check is possible.
 */
export function canRevalidateCheaply(entry: CacheEntry): boolean {
  return entry.etag !== null || entry.total !== null;
}
