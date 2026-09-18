/**
 * Which service a MusicBrainz resolution actually calls.
 *
 * The resolver called `musicbrainz.org` directly from the day it was written,
 * at one request per second globally per IP, while `listenbrainz_client.ts`
 * sat unused having been built for exactly this at thirty per nine seconds.
 * Nothing caught it because both paths produce a correct answer — one is
 * simply thirty times slower and returns 503 under sustained load.
 *
 * These assert the routing, not the answer: with a token, ListenBrainz is
 * asked first; without one, MusicBrainz still works.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { prepareMediaCache } from "../../src/cache/media_cache_store";
import { enqueueResolutions } from "../../src/resolver/resolution_queue";
import { runResolutionTask } from "../../src/resolver/resolve_artist_totals";
import { SpotifyApiClient } from "../../src/providers/spotify/spotify_api_client";

const database = env.MEDIA_CACHE as D1Database;

/** Never reached on this path; any call through it is a routing failure. */
const UNUSABLE_CLIENT = new SpotifyApiClient("not-a-real-token");

const TASK = {
  kind: "resolve-musicbrainz" as const,
  subjectUri: "spotify:track:t1",
  priority: 1,
  cursor: null,
  accumulated: 0,
  attempts: 0,
};

/** Hosts each request went to, so the test can assert who was asked. */
function recordRequestedHosts(): { hosts: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const hosts: string[] = [];

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    hosts.push(new URL(url).host);
    // An empty body is how ListenBrainz signals no match, and is a valid
    // MusicBrainz response shape too — so neither path errors, and the test
    // measures routing rather than parsing.
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  return { hosts, restore: () => { globalThis.fetch = original; } };
}

describe("resolve-musicbrainz routing", () => {
  beforeEach(async () => {
    await prepareMediaCache(database);
    await database.prepare("DELETE FROM resolution_queue").run();
    await database.prepare("DELETE FROM track_artist").run();
    await database.prepare("DELETE FROM artist").run();
    await database.prepare("DELETE FROM track").run();
    await database
      .prepare(
        `INSERT INTO track (uri, id, name, duration_seconds, isrc, is_liked, cached_at)
           VALUES ('spotify:track:t1', 't1', 'Comfortably Numb', 382.28, 'GBAYE7800404', 1, 0)`,
      )
      .run();
    await database
      .prepare(`INSERT INTO artist (uri, id, name, genres, is_followed, cached_at)
                  VALUES ('spotify:artist:a1', 'a1', 'Pink Floyd', '[]', 1, 0)`)
      .run();
    await database
      .prepare(`INSERT INTO track_artist (track_uri, artist_uri)
                  VALUES ('spotify:track:t1', 'spotify:artist:a1')`)
      .run();
    await enqueueResolutions(database, [TASK], Date.now());
  });

  test("asks ListenBrainz first when a token is supplied", async () => {
    const { hosts, restore } = recordRequestedHosts();
    try {
      await runResolutionTask(database, UNUSABLE_CLIENT, TASK, undefined, "a-token");
    } finally {
      restore();
    }

    expect(hosts[0]).toBe("api.listenbrainz.org");
  });

  test("falls back to MusicBrainz when no token is configured", async () => {
    // The degradation must stay correct: a deployment with no ListenBrainz
    // token still resolves, thirty times slower.
    const { hosts, restore } = recordRequestedHosts();
    try {
      await runResolutionTask(database, UNUSABLE_CLIENT, TASK, undefined, undefined);
    } finally {
      restore();
    }

    expect(hosts[0]).toBe("musicbrainz.org");
    expect(hosts).not.toContain("api.listenbrainz.org");
  });

  test("never reaches Spotify on this path", async () => {
    const { hosts, restore } = recordRequestedHosts();
    try {
      await runResolutionTask(database, UNUSABLE_CLIENT, TASK, undefined, "a-token");
    } finally {
      restore();
    }

    expect(hosts).not.toContain("api.spotify.com");
  });
});
