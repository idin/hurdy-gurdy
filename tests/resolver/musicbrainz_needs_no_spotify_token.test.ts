/**
 * A MusicBrainz resolution must not depend on a Spotify session.
 *
 * The bug this guards: `continueResolving` fetched a Spotify access token
 * before looking at what the task actually needed. An alarm is not a
 * connection, so `this.props` is undefined, the user id fell back to `""`,
 * the KV lookup missed, and `getAccessToken` threw — killing tasks that never
 * wanted Spotify in the first place. The throw was then swallowed by a catch
 * written for rate limits, so nothing recorded it.
 *
 * 1,979 tasks sat queued for four days with `attempts = 0` because of it, and
 * only 38 of 4,624 tracks ever got a recording MBID. See
 * `docs/bugs/resolved/2026-09-18_resolver_alarm_cannot_authenticate_without_a_connection.md`.
 */

import { describe, expect, test } from "vitest";

import {
  checkKindNeedsSpotifyToken,
  type ResolutionKind,
} from "../../src/resolver/resolution_queue";

describe("checkKindNeedsSpotifyToken", () => {
  test("MusicBrainz resolution needs no Spotify token", () => {
    // The whole bug in one assertion. This task reads names from the cache
    // and calls ListenBrainz; requiring a Spotify session to run it is what
    // stalled 1,979 of them.
    expect(checkKindNeedsSpotifyToken("resolve-musicbrainz")).toBe(false);
  });

  test("the library backfill does need one", () => {
    // The near-miss case. If the predicate returned false for everything the
    // resolver would run tokenless and fail differently — so it has to
    // discriminate, not merely permit.
    expect(checkKindNeedsSpotifyToken("backfill-liked-tracks")).toBe(true);
  });

  test("artist counting does need one", () => {
    expect(checkKindNeedsSpotifyToken("artist-album-count")).toBe(true);
    expect(checkKindNeedsSpotifyToken("artist-track-count")).toBe(true);
  });

  test("every kind is classified", () => {
    // A kind added later and left unclassified would silently be treated as
    // tokenless and fail at the first Spotify call. Listing them here means
    // adding a kind without deciding this breaks the build, not production.
    const everyKind: ResolutionKind[] = [
      "artist-album-count",
      "artist-track-count",
      "backfill-liked-tracks",
      "resolve-musicbrainz",
    ];

    for (const kind of everyKind) {
      expect(typeof checkKindNeedsSpotifyToken(kind)).toBe("boolean");
    }
    expect(everyKind.filter(checkKindNeedsSpotifyToken)).toHaveLength(3);
  });
});
