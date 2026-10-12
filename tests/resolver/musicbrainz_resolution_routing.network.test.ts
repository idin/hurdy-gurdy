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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { prepareMediaCache } from "../../src/cache/media_cache_store";
import { enqueueResolutions, RESOLUTION_PRIORITY } from "../../src/resolver/resolution_queue";
import type { ResolutionTask } from "../../src/resolver/resolution_queue";
import { runResolutionTask } from "../../src/resolver/resolve_artist_totals";
import { SpotifyApiClient } from "../../src/providers/spotify/spotify_api_client";
import { startLocalWorkersStorage, type LocalWorkersStorage } from "../local_workers_storage";
import { startLocalHttpServer, type LocalHttpServer } from "../local_http_server";
import { startLocalSpotifyServer, type LocalSpotifyServer } from "../providers/spotify/local_spotify_server";

let storage: LocalWorkersStorage;
let database: D1Database;

beforeAll(async () => {
  storage = await startLocalWorkersStorage();
  database = storage.database;
});

afterAll(async () => {
  await storage.dispose();
});

const TASK: ResolutionTask = {
  kind: "resolve-musicbrainz",
  subjectUri: "spotify:track:t1",
  priority: RESOLUTION_PRIORITY.BACKFILL,
  cursor: null,
  accumulated: 0,
  attempts: 0,
};

/**
 * Three real local servers, one per service the resolver could call, so which
 * one was asked is read off the requests each received. An empty JSON body is
 * how ListenBrainz signals no match, and is a valid MusicBrainz response shape
 * too, so neither path errors and the test measures routing rather than parsing.
 */
type Upstreams = {
  listenBrainz: LocalHttpServer;
  musicBrainz: LocalHttpServer;
  spotify: LocalSpotifyServer;
};

let upstreams: Upstreams;

beforeEach(async () => {
  const empty = () => ({ status: 200, body: {} });
  upstreams = {
    listenBrainz: await startLocalHttpServer({ respond: empty }),
    musicBrainz: await startLocalHttpServer({ respond: empty }),
    spotify: await startLocalSpotifyServer({ respond: empty }),
  };
});

afterEach(async () => {
  await Promise.all([upstreams.listenBrainz.close(), upstreams.musicBrainz.close(), upstreams.spotify.close()]);
});

/** Runs the task with every service aimed at its local server. */
async function runTask(listenBrainzToken: string | undefined): Promise<void> {
  // Any request reaching Spotify on this path is a routing failure.
  const client = new SpotifyApiClient("not-a-real-token", {
    grantedScopes: null,
    apiBaseUrl: upstreams.spotify.apiBaseUrl,
  });
  await runResolutionTask(database, client, TASK, undefined, listenBrainzToken, {
    listenBrainzApiBaseUrl: `${upstreams.listenBrainz.origin}/1`,
    musicBrainzApiBaseUrl: `${upstreams.musicBrainz.origin}/ws/2`,
  });
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
    await runTask("a-token");

    expect(upstreams.listenBrainz.requests.length).toBeGreaterThan(0);
    expect(upstreams.listenBrainz.requests[0].path).toBe("/1/metadata/lookup/");
  });

  test("falls back to MusicBrainz when no token is configured", async () => {
    // The degradation must stay correct: a deployment with no ListenBrainz
    // token still resolves, thirty times slower.
    await runTask(undefined);

    expect(upstreams.musicBrainz.requests.length).toBeGreaterThan(0);
    expect(upstreams.musicBrainz.requests[0].path).toContain("/ws/2/isrc/");
    expect(upstreams.listenBrainz.requests).toHaveLength(0);
  });

  test("never reaches Spotify on this path", async () => {
    await runTask("a-token");

    expect(upstreams.spotify.requests).toHaveLength(0);
  });
});
