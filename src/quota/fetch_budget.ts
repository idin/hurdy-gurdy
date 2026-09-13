/**
 * A per-user monthly budget on **uncached** work.
 *
 * Cloudflare offers no spending cap of any kind — no budget limit, no hard
 * stop, only overage billing. So on a shared deployment the ceiling is
 * whatever this file makes it, and nothing outside enforces one.
 *
 * ## Why uncached fetches specifically
 *
 * Budgeting requests would be the obvious move and the wrong one. A user who
 * reads the same artist a hundred times costs one upstream fetch and
 * ninety-nine cache hits; charging them for a hundred would punish exactly
 * the behaviour the cache exists to encourage, and would make a warm, cheap
 * user look like an expensive one.
 *
 * What actually costs money is work that leaves the building: a Spotify call,
 * a MusicBrainz call, a resolver crawl. Those are bounded here. Reads served
 * from D1 are effectively free and are deliberately not counted.
 *
 * ## Why not the Rate Limiting binding
 *
 * Cloudflare's rate-limit binding is keyed per user and costs nothing, but it
 * supports **only 10 or 60 second periods** and its counters are **per-colo,
 * not global**. That makes it a burst guard — it stops one user hammering the
 * server in a moment — and not a budget: a user could stay under 100 requests
 * a minute indefinitely and still exceed a month's allowance.
 *
 * The two are complementary. This is the budget; the binding, if added later,
 * is the burst guard.
 */

/**
 * Uncached fetches one user may spend per calendar month.
 *
 * Derived, not chosen. The Workers Paid plan includes 10 million requests and
 * 1 million Durable Object requests a month. A single user's ordinary session
 * — a library read, a few searches, some playback — is tens of fetches. Ten
 * thousand allows a full library backfill (roughly 2,300 liked tracks at 50
 * per page, plus artist crawls) several times over, while a hundred such
 * users still sit inside the included allowance.
 *
 * Raise it deliberately and recompute, rather than nudging it when someone
 * complains.
 */
export const MONTHLY_FETCH_BUDGET = 10_000;

/**
 * What a budget check concluded.
 *
 * `remaining` is carried even on refusal so a caller can say how long the
 * user has to wait rather than only that they cannot proceed.
 */
export type BudgetVerdict = {
  allowed: boolean;
  spent: number;
  remaining: number;
  /** The month this applies to, as `YYYY-MM`. */
  period: string;
};

/**
 * The budget period a moment falls in.
 *
 * Calendar months rather than rolling windows: a rolling window needs every
 * individual event retained to know what has aged out, while a calendar month
 * is one counter that resets. The reset is also explicable to a user — "it
 * resets on the first" — where a rolling window is not.
 *
 * @param now - Epoch milliseconds.
 * @returns `YYYY-MM` in UTC.
 */
export function findBudgetPeriod(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** The table the counters live in. Created by the cache schema. */
export const FETCH_BUDGET_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS fetch_budget (
     user_id     TEXT NOT NULL,
     period      TEXT NOT NULL,
     spent       INTEGER NOT NULL DEFAULT 0,
     updated_at  INTEGER NOT NULL,
     PRIMARY KEY (user_id, period)
   )`,
];

/**
 * Whether a user may spend more uncached fetches, without spending one.
 *
 * Read-only. Checking and spending are separate so a caller can report a
 * user's standing — a status tool, a warning near the limit — without the act
 * of looking costing them anything.
 *
 * @param database - Where the counters live.
 * @param userId - Whose budget. On a single-user deployment, the Spotify id.
 * @param now - Epoch milliseconds.
 * @param budget - Override, for tests and for per-tier limits later.
 */
export async function checkFetchBudget(
  database: D1Database,
  userId: string,
  now: number,
  budget: number = MONTHLY_FETCH_BUDGET,
): Promise<BudgetVerdict> {
  const period = findBudgetPeriod(now);
  const row = await database
    .prepare(`SELECT spent FROM fetch_budget WHERE user_id = ? AND period = ?`)
    .bind(userId, period)
    .first<{ spent: number }>();

  const spent = row?.spent ?? 0;
  return {
    allowed: spent < budget,
    spent,
    remaining: Math.max(0, budget - spent),
    period,
  };
}

/**
 * Record uncached fetches against a user's budget.
 *
 * Counts after the work rather than reserving before it: a fetch that failed
 * cost an upstream call and should be counted, while a reservation that was
 * never used would have to be returned, and a returned reservation is a
 * second thing that can go wrong.
 *
 * Never throws. A budget that cannot be written is a lost count, and failing
 * the user's actual question over bookkeeping would trade something they
 * asked for against something they did not.
 *
 * @param database - Where the counters live.
 * @param userId - Whose budget.
 * @param count - How many uncached fetches were made.
 * @param now - Epoch milliseconds.
 */
export async function recordFetchSpend(
  database: D1Database,
  userId: string,
  count: number,
  now: number,
): Promise<void> {
  if (count <= 0) {
    return;
  }
  try {
    await database
      .prepare(
        `INSERT INTO fetch_budget (user_id, period, spent, updated_at)
           VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, period) DO UPDATE SET
           spent = fetch_budget.spent + excluded.spent,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, findBudgetPeriod(now), count, now)
      .run();
  } catch {
    // A lost count is cheaper than a failed answer.
  }
}

/**
 * Explain a refusal in terms a user can act on.
 *
 * Says what is still free, because that is the part that makes the limit
 * tolerable: a budget that reads as "you are cut off" when in fact the entire
 * cached catalogue remains available describes the system wrongly.
 *
 * @param verdict - From `checkFetchBudget`.
 * @returns A message naming the limit, the period and what still works.
 */
export function describeBudgetRefusal(verdict: BudgetVerdict): string {
  return (
    `Monthly limit reached: ${verdict.spent} uncached lookups used in `
    + `${verdict.period}. This resets at the start of next month.\n\n`
    + `Anything already cached still works — library listings, playlists, `
    + `coverage and every search whose results have been seen before. Only `
    + `fetching something new from Spotify is paused.`
  );
}
