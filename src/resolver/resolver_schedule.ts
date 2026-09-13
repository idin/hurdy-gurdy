/**
 * How often the resolver wakes, and how it backs off.
 *
 * The queue drains from a Durable Object alarm rather than from a request,
 * because the work outlives any single call: one artist's track total is 32
 * requests against a Worker budget of 50, so it cannot ride along with a
 * question someone asked.
 *
 * **Every tick is a billable Durable Object request**, and the alarm is the
 * only thing here that runs continuously — so it is the only part of this
 * project whose cost scales with time rather than with use. Cloudflare's
 * Workers Paid plan includes one million DO requests a month and offers **no
 * spending cap of any kind**: no budget limit, no hard stop, only overage at
 * $0.15 per additional million. The ceiling has to be built in, because
 * nothing outside enforces one.
 *
 * A uniform three-second tick — which this file briefly had — is 864,000
 * requests a month, **86% of the included allowance before anything else
 * runs**. The rates below spend 9% instead, and clear a backlog just as fast,
 * because speed is only needed while there is a backlog.
 */

/**
 * Seconds between ticks while a large backlog remains.
 *
 * Fast, deliberately. A first library scan queues a few hundred artists and
 * clears in roughly two hours at this rate, which is worth 22,000 requests —
 * about 2% of a month's allowance for the whole initial population.
 */
export const RESOLVER_BURST_SECONDS = 3;

/**
 * Seconds between ticks with a small backlog.
 *
 * The steady state. Thirty seconds is 86,400 requests a month, under 9% of
 * the allowance, and still drains 2,880 tasks a day — far more than ordinary
 * use generates.
 */
export const RESOLVER_TICK_SECONDS = 30;

/**
 * Queue depth above which the fast rate is used.
 *
 * Above this there is real backlog and finishing matters; below it the work
 * is a trickle of newly-seen artists that nobody is waiting on.
 */
export const BACKLOG_THRESHOLD = 20;

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
 * cost — 8,640 requests a month at this rate, under 1% of the allowance, for
 * a resolver that is doing nothing at all. Work arriving while it sleeps does
 * not wait: a library read schedules a tick immediately when it enqueues.
 */
export const RESOLVER_IDLE_SECONDS = 300;

/**
 * How long to wait before the next tick.
 *
 * @param outcome.pending - How much work remains queued.
 * @param outcome.rateLimited - Whether the provider refused for rate limiting.
 * @returns Seconds until the resolver should wake again.
 */
export function findNextTickDelay(outcome: {
  pending: number;
  rateLimited: boolean;
}): number {
  if (outcome.rateLimited) {
    return RESOLVER_BACKOFF_SECONDS;
  }
  if (outcome.pending === 0) {
    return RESOLVER_IDLE_SECONDS;
  }
  return outcome.pending > BACKLOG_THRESHOLD
    ? RESOLVER_BURST_SECONDS
    : RESOLVER_TICK_SECONDS;
}
