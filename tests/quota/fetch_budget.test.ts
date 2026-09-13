import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";

import { CachedMediaProvider } from "../../src/cache/cached_media_provider";
import { prepareMediaCache } from "../../src/cache/media_cache_store";
import {
  checkFetchBudget,
  findBudgetPeriod,
  recordFetchSpend,
} from "../../src/quota/fetch_budget";
import type { MediaProvider, Page, Track } from "../../src/providers/media_provider";

/**
 * The property this exists to guarantee: **a cache hit is free.**
 *
 * Budgeting requests rather than uncached fetches would punish exactly the
 * behaviour the cache exists to encourage — a user who reads the same artist
 * a hundred times costs one upstream call and would be charged for a hundred.
 * Several tests below assert that hits do not move the counter, because that
 * is the easiest thing to break while everything still appears to work.
 */

const database = (env as { MEDIA_CACHE: D1Database }).MEDIA_CACHE;
const NOW = Date.parse("2026-09-13T12:00:00Z");
const USER = "idin.k";

function trackPage(): Page<Track> {
  return {
    items: [
      {
        uri: "spotify:track:t1",
        inLibrary: true,
        id: "t1",
        name: "Echoes",
        artists: [],
        artistNames: [],
        albumName: null,
        albumUri: null,
        durationMs: 1,
      },
    ],
    nextCursor: null,
    total: 1,
  };
}

function countingProvider() {
  let calls = 0;
  const provider = {
    name: "spotify",
    async getLikedTracks() {
      calls += 1;
      return trackPage();
    },
  } as unknown as MediaProvider;
  return { provider, getCalls: () => calls };
}

async function spent(): Promise<number> {
  return (await checkFetchBudget(database, USER, NOW)).spent;
}

beforeEach(async () => {
  await prepareMediaCache(database);
  for (const table of ["fetch_budget", "cached_response", "track", "artist", "album"]) {
    await database.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("what the budget counts", () => {
  test("a cache miss costs one fetch", async () => {
    const { provider } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW, USER);

    await cached.getLikedTracks();

    expect(await spent()).toBe(1);
  });

  test("a cache HIT costs nothing", async () => {
    // The whole point. If this fails, the budget punishes caching.
    const { provider, getCalls } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW, USER);

    await cached.getLikedTracks();
    await cached.getLikedTracks();
    await cached.getLikedTracks();

    expect(getCalls()).toBe(1);
    expect(await spent()).toBe(1);
  });

  test("a hundred reads of one thing cost one fetch", async () => {
    const { provider } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW, USER);

    for (let read = 0; read < 100; read += 1) {
      await cached.getLikedTracks();
    }

    expect(await spent()).toBe(1);
  });

  test("nothing is charged when no user is set", async () => {
    // Single-user deployments have nobody to bill, and the check is overhead.
    const { provider } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW);

    await cached.getLikedTracks();

    expect(await spent()).toBe(0);
  });
});

describe("enforcement", () => {
  test("refuses once the budget is spent", async () => {
    await recordFetchSpend(database, USER, 10_000, NOW);
    const { provider } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW, USER);

    await expect(cached.getLikedTracks()).rejects.toThrow(/Monthly limit reached/);
  });

  test("the refusal says what still works", async () => {
    // A limit that reads as "you are cut off" describes the system wrongly:
    // the entire cached catalogue is still available.
    await recordFetchSpend(database, USER, 10_000, NOW);
    const { provider } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW, USER);

    await expect(cached.getLikedTracks()).rejects.toThrow(/already cached still works/);
  });

  test("a spent budget still serves cache hits", async () => {
    // The behaviour that makes the limit tolerable, and the reason the check
    // sits on the miss path rather than at the top of the method.
    const { provider } = countingProvider();
    const cached = new CachedMediaProvider(provider, database, () => NOW, USER);
    await cached.getLikedTracks();

    await recordFetchSpend(database, USER, 10_000, NOW);

    const page = await cached.getLikedTracks();
    expect(page.items).toHaveLength(1);
  });

  test("one user's spending does not affect another's", async () => {
    await recordFetchSpend(database, "someone-else", 10_000, NOW);

    expect((await checkFetchBudget(database, USER, NOW)).allowed).toBe(true);
  });
});

describe("periods", () => {
  test("a period is the calendar month in UTC", () => {
    expect(findBudgetPeriod(Date.parse("2026-09-13T12:00:00Z"))).toBe("2026-09");
  });

  test("spending resets at the month boundary", async () => {
    await recordFetchSpend(database, USER, 10_000, NOW);

    const nextMonth = Date.parse("2026-10-01T00:00:00Z");
    expect((await checkFetchBudget(database, USER, nextMonth)).allowed).toBe(true);
  });

  test("spending accumulates within a month", async () => {
    await recordFetchSpend(database, USER, 5, NOW);
    await recordFetchSpend(database, USER, 7, NOW + 60_000);

    expect(await spent()).toBe(12);
  });
});
