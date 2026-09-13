/**
 * A cached provider response, and the rule that decides when it expires.
 *
 * The rule is a *sliding* expiry: reading an entry pushes its expiry back, so
 * a working set stays warm indefinitely while a one-off lookup falls out on
 * its own. That is what makes this a cache rather than a database, which
 * matters legally as well as technically — Spotify's Developer Terms permit
 * "temporary caching" and forbid storing their content indefinitely, and an
 * entry that is deleted when unused is temporary in the plain sense of the
 * word.
 *
 * Nothing here talks to a database or to a provider. The rule is separated
 * from both so it can be tested against a clock rather than against a network.
 */

/**
 * How long an unread entry survives.
 *
 * 66 days, chosen by Idin. Long enough that anything touched even occasionally
 * stays resident — a monthly listening habit never re-fetches — and short
 * enough that content nobody has looked at in over two months genuinely leaves
 * the system.
 */
export const CACHE_TIME_TO_LIVE_MILLISECONDS = 66 * 24 * 60 * 60 * 1000;

/**
 * One cached response.
 *
 * `etag` is what makes a stale entry cheap to renew: Spotify answers a
 * conditional request with `304 Not Modified` and no body, which costs no
 * quota and proves the cached payload is still correct.
 */
export type CacheEntry = {
  /** Identifies the request this answers. See `buildCacheKey`. */
  key: string;
  /** The provider's response body, as stored. */
  payload: string;
  /** The provider's ETag, when it gave one. */
  etag: string | null;
  /**
   * The collection's total item count at the time this was stored, when the
   * provider reported one. A changed total is how an addition or removal is
   * noticed without walking the whole collection.
   */
  total: number | null;
  /** Epoch milliseconds. Past this, the entry must be revalidated. */
  expiresAt: number;
};

/** What a read of the cache found, and what the caller must do about it. */
export type CacheLookup =
  /** Usable as-is. The entry's expiry has already been pushed back. */
  | { state: "fresh"; entry: CacheEntry }
  /**
   * Present but past its expiry. Revalidate with `etag` — a `304` means the
   * payload is still good and only the expiry needs renewing.
   */
  | { state: "stale"; entry: CacheEntry }
  /** Nothing cached. Fetch it. */
  | { state: "missing" };

/**
 * Build the key identifying one provider request.
 *
 * The provider name is part of the key so two providers answering the same
 * logical question — "this user's liked tracks" — never collide. The cursor is
 * part of it because each page is a separate response with its own ETag.
 *
 * @param provider - The provider's own name, e.g. `"spotify"`.
 * @param method - The `MediaProvider` method called, e.g. `"getLikedTracks"`.
 * @param parameters - Everything that varies the response: cursor, limit,
 *   playlist id, query. Order-independent — sorted before joining, so two
 *   callers passing the same parameters in a different order share one entry.
 * @returns A stable key for this exact request.
 */
export function buildCacheKey(
  provider: string,
  method: string,
  parameters: Record<string, string | number | undefined>,
): string {
  const settled = Object.entries(parameters)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .sort();
  return [provider, method, ...settled].join(":");
}

/**
 * Decide what a stored entry is worth, and renew it if it is still good.
 *
 * Renewal happens here rather than at the call site because an entry that is
 * read but not renewed would expire while in active use — the exact failure
 * the sliding rule exists to prevent, and one that would only show up as
 * mysterious re-fetching weeks later.
 *
 * @param entry - The stored entry, or null when nothing was found.
 * @param now - Epoch milliseconds. Passed rather than read from the clock so
 *   the rule is testable.
 * @returns What state the entry is in. A `fresh` result carries an entry whose
 *   `expiresAt` has already been pushed forward; the caller persists it.
 */
export function lookUpCacheEntry(entry: CacheEntry | null, now: number): CacheLookup {
  if (entry === null) {
    return { state: "missing" };
  }
  if (entry.expiresAt <= now) {
    return { state: "stale", entry };
  }
  return {
    state: "fresh",
    entry: { ...entry, expiresAt: now + CACHE_TIME_TO_LIVE_MILLISECONDS },
  };
}

/**
 * The expiry a newly written or revalidated entry should carry.
 *
 * @param now - Epoch milliseconds.
 * @returns When this entry expires if never read again.
 */
export function expiryFrom(now: number): number {
  return now + CACHE_TIME_TO_LIVE_MILLISECONDS;
}
