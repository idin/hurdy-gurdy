import { describe, expect, test } from "vitest";

import {
  BACKLOG_THRESHOLD,
  findNextTickDelay,
  RESOLVER_BACKOFF_SECONDS,
  RESOLVER_BURST_SECONDS,
  RESOLVER_IDLE_SECONDS,
  RESOLVER_TICK_SECONDS,
} from "../../src/resolver/resolver_schedule";

/**
 * These are a cost control, not a performance tuning.
 *
 * Every tick is a billable Durable Object request, the alarm is the only
 * thing that runs continuously, and Cloudflare offers **no spending cap of
 * any kind** — no budget limit, no hard stop, only overage billing. So the
 * ceiling is whatever these constants make it, and a change here is a change
 * to the monthly bill.
 *
 * The arithmetic is asserted rather than described, because a comment saying
 * "about 9% of the allowance" stops being true the moment someone edits a
 * constant and does not recompute it.
 */

const SECONDS_PER_MONTH = 30 * 86_400;
const INCLUDED_DO_REQUESTS_PER_MONTH = 1_000_000;

describe("tick pacing", () => {
  test("bursts while a real backlog remains", () => {
    expect(findNextTickDelay({ pending: BACKLOG_THRESHOLD + 1, rateLimited: false })).toBe(
      RESOLVER_BURST_SECONDS,
    );
  });

  test("settles to the steady rate on a small queue", () => {
    expect(findNextTickDelay({ pending: 1, rateLimited: false })).toBe(RESOLVER_TICK_SECONDS);
  });

  test("sleeps when there is nothing to do", () => {
    expect(findNextTickDelay({ pending: 0, rateLimited: false })).toBe(RESOLVER_IDLE_SECONDS);
  });

  test("backs off on a rate limit, whatever the queue looks like", () => {
    // Ticking again immediately spends the very quota being waited on.
    expect(findNextTickDelay({ pending: 5_000, rateLimited: true })).toBe(
      RESOLVER_BACKOFF_SECONDS,
    );
  });
});

describe("cost ceiling", () => {
  test("the steady rate stays under a tenth of the included allowance", () => {
    // This is the number that matters. A uniform 3s tick — which this file
    // briefly had — is 864,000/month, 86% of the allowance before anything
    // else runs.
    const monthly = SECONDS_PER_MONTH / RESOLVER_TICK_SECONDS;

    expect(monthly).toBeLessThan(INCLUDED_DO_REQUESTS_PER_MONTH * 0.1);
  });

  test("even permanent bursting stays inside the allowance", () => {
    // The worst case: a queue that never drops below the threshold. It should
    // be expensive-ish but not an overage, so a runaway backlog cannot
    // produce a bill on its own.
    const monthly = SECONDS_PER_MONTH / RESOLVER_BURST_SECONDS;

    expect(monthly).toBeLessThan(INCLUDED_DO_REQUESTS_PER_MONTH);
  });

  test("an idle resolver costs almost nothing", () => {
    const monthly = SECONDS_PER_MONTH / RESOLVER_IDLE_SECONDS;

    expect(monthly).toBeLessThan(INCLUDED_DO_REQUESTS_PER_MONTH * 0.01);
  });

  test("burst is faster than steady, which is faster than idle", () => {
    // Ordering, so a future edit cannot accidentally invert them.
    expect(RESOLVER_BURST_SECONDS).toBeLessThan(RESOLVER_TICK_SECONDS);
    expect(RESOLVER_TICK_SECONDS).toBeLessThan(RESOLVER_IDLE_SECONDS);
  });
});
