/**
 * The resolver must recognise a rate limit from every upstream it calls.
 *
 * The bug this guards: the alarm's backoff check tested only Spotify. A
 * MusicBrainz 503 fell through to the ordinary three-second tick, so the
 * resolver kept calling a service that had just refused — and MusicBrainz's
 * limit is global per IP, meaning the excess blocks every other request from
 * the address rather than only itself.
 *
 * Measured 2026-09-19: a bulk pass managed seven lookups in an hour against
 * exactly that, because nothing was reading the refusal.
 */

import { describe, expect, it } from "vitest";

import { isMusicBrainzBusy, MusicBrainzError } from "../../src/catalogue/musicbrainz_client";
import {
  isListenBrainzRateLimited,
  ListenBrainzError,
} from "../../src/catalogue/listenbrainz_client";
import { findNextTickDelay, RESOLVER_BACKOFF_SECONDS } from "../../src/resolver/resolver_schedule";

describe("rate-limit detection per upstream", () => {
  it("recognises a MusicBrainz 503 as a rate limit", () => {
    expect(isMusicBrainzBusy(new MusicBrainzError(503, "busy"))).toBe(true);
  });

  it("does not mistake a MusicBrainz 404 for a rate limit", () => {
    // The near-miss. A 404 is an answer — this ISRC is unknown — and backing
    // off for a minute over it would stall the queue on missing data.
    expect(isMusicBrainzBusy(new MusicBrainzError(404, "not found"))).toBe(false);
  });

  it("recognises a ListenBrainz 429 as a rate limit", () => {
    expect(isListenBrainzRateLimited(new ListenBrainzError(429, "slow down"))).toBe(true);
  });

  it("does not mistake a ListenBrainz 400 for a rate limit", () => {
    expect(isListenBrainzRateLimited(new ListenBrainzError(400, "bad request"))).toBe(false);
  });
});

describe("the schedule backs off on a rate limit", () => {
  it("waits the backoff period regardless of queue depth", () => {
    // A deep queue must not override the backoff: the whole failure was a
    // resolver that kept ticking fast at a service telling it to stop.
    expect(findNextTickDelay({ pending: 5_000, rateLimited: true })).toBe(
      RESOLVER_BACKOFF_SECONDS,
    );
  });

  it("paces MusicBrainz work slowly even with a large backlog", () => {
    const delay = findNextTickDelay({
      pending: 1_144,
      rateLimited: false,
      usesMusicBrainz: true,
    });

    // Must not take the burst rate, however long the queue is.
    expect(delay).toBeGreaterThanOrEqual(3);
  });
});
