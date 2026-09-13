/**
 * How often the resolver wakes, and how it backs off.
 *
 * The queue drains from a Durable Object alarm rather than from a request,
 * because the work outlives any single call: one artist's track total is 32
 * requests against a Worker budget of 50, so it cannot ride along with a
 * question someone asked.
 */

/**
 * Seconds between ticks while work remains.
 *
 * Three seconds, because Idin's instruction was explicit: *"i don't mind if
 * we get to the limits and have to wait"*. Backfilling a 2,282-track library
 * and resolving a few hundred artists is work that has to happen once, and
 * finishing it in an hour beats trickling it over a day.
 *
 * Hitting Spotify's rate limit is not a failure here — `RESOLVER_BACKOFF_SECONDS`
 * handles it, and a limit reached while doing real work is cheaper than a
 * queue that never empties.
 */
export const RESOLVER_TICK_SECONDS = 3;

/**
 * Seconds to wait after a rate-limit refusal.
 *
 * Backing off matters more than retrying: the ordinary delay spends the very
 * quota the resolver is waiting on, which is how a background job turns a
 * brief limit into a sustained one.
 */
export const RESOLVER_BACKOFF_SECONDS = 60;

/**
 * Seconds to wait when the queue is empty.
 *
 * Long, because nothing is pending and a tick that finds nothing is pure
 * cost. Work arriving while the resolver sleeps does not wait for this — a
 * library read schedules a tick immediately when it enqueues something.
 */
export const RESOLVER_IDLE_SECONDS = 300;

/**
 * How long to wait before the next tick.
 *
 * @param outcome.hasWork - Whether anything remains queued.
 * @param outcome.rateLimited - Whether the provider refused for rate limiting.
 * @returns Seconds until the resolver should wake again.
 */
export function findNextTickDelay(outcome: {
  hasWork: boolean;
  rateLimited: boolean;
}): number {
  if (outcome.rateLimited) {
    return RESOLVER_BACKOFF_SECONDS;
  }
  return outcome.hasWork ? RESOLVER_TICK_SECONDS : RESOLVER_IDLE_SECONDS;
}
