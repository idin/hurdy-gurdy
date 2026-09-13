/**
 * Filling in the denominators a search cannot afford to compute.
 *
 * `likedTrackCount` is cheap — the cache already holds the library, and the
 * views count it. `totalTrackCount` is not: Spotify publishes no such figure
 * for an artist, so it has to be summed across every release they have, and
 * `/artists/{id}/albums` caps at **ten per page**. Verified on the live API
 * 2026-09-13, where `limit=20` and `limit=50` both return `400 Invalid limit`.
 *
 * One artist in Idin's library has 312 releases. That is 32 requests for one
 * number, against a Worker budget of 50 for an entire invocation — so it
 * cannot be done while anyone waits, and it cannot even be done in one
 * background tick.
 *
 * The split that makes this tractable: **`total` arrives on page one.** So
 * `totalAlbumCount` costs a single request and lands almost immediately for
 * every artist, while `totalTrackCount` crawls page by page across many
 * ticks, resuming from a stored cursor.
 */

import type { SpotifyApiClient } from "../providers/spotify/spotify_api_client";
import {
  advanceResolution,
  completeResolution,
  recordResolutionFailure,
  type ResolutionTask,
} from "./resolution_queue";

/**
 * Releases per page.
 *
 * Spotify's cap for this endpoint specifically, and lower than the 50 its
 * library endpoints accept — a development-mode restriction found by trying
 * it, not by reading the documentation, which still describes 50.
 */
export const ARTIST_ALBUMS_PAGE_SIZE = 10;

/**
 * Pages to crawl in one tick.
 *
 * Deliberately small. A tick shares its subrequest budget with whatever
 * request triggered it, and a resolver that spends the budget makes the
 * user's actual question fail — which trades something they asked for against
 * something they did not.
 */
export const PAGES_PER_TICK = 3;

/**
 * Which release types count toward an artist's totals.
 *
 * Albums and singles: the artist's own output. `appears_on` is excluded
 * because a compilation of other artists' work would inflate the denominator
 * with records that are not theirs — Idin's ruling, 2026-09-13.
 */
export const COUNTED_ALBUM_GROUPS = "album,single";

/** Extracts the artist id from a `spotify:artist:...` URI. */
function findArtistId(subjectUri: string): string {
  return subjectUri.split(":").pop() ?? subjectUri;
}

/**
 * Do one unit of resolver work.
 *
 * Failure is recorded rather than thrown: the caller is a background alarm
 * with nobody to report to, and a task that fails three times stops being
 * selected rather than blocking the tier behind it.
 *
 * @param database - Where the cache and queue live.
 * @param client - An authenticated Spotify client.
 * @param task - What to work on.
 * @returns What happened, for logging and for tests.
 */
export async function runResolutionTask(
  database: D1Database,
  client: SpotifyApiClient,
  task: ResolutionTask,
): Promise<{ outcome: "completed" | "advanced" | "failed" }> {
  try {
    if (task.kind === "artist-album-count") {
      await resolveAlbumCount(database, client, task);
      return { outcome: "completed" };
    }
    const finished = await advanceTrackCount(database, client, task);
    return { outcome: finished ? "completed" : "advanced" };
  } catch {
    await recordResolutionFailure(database, task);
    return { outcome: "failed" };
  }
}

/**
 * Count an artist's releases. One request.
 *
 * The endpoint reports `total` alongside the first page, so no crawl is
 * needed — this is why the album count lands quickly while the track count
 * does not.
 */
async function resolveAlbumCount(
  database: D1Database,
  client: SpotifyApiClient,
  task: ResolutionTask,
): Promise<void> {
  const page = await client.getArtistAlbums(findArtistId(task.subjectUri), {
    limit: ARTIST_ALBUMS_PAGE_SIZE,
    offset: 0,
  });

  await database
    .prepare(`UPDATE artist SET total_album_count = ? WHERE uri = ?`)
    .bind(page.total, task.subjectUri)
    .run();

  await completeResolution(database, task);
}

/**
 * Sum an artist's track counts, a few pages at a time.
 *
 * Each release carries its own `total_tracks`, so this is arithmetic over
 * pages rather than a second request per album — which would turn 32 requests
 * into several hundred.
 *
 * The running total is written to the artist row **only when the crawl
 * finishes**. A partial sum is a wrong number, and a wrong denominator is
 * worse than an absent one: "3 of 40" when the truth is "3 of 312" reads as
 * a strong relationship where there is a weak one.
 *
 * @returns True when the crawl is complete.
 */
async function advanceTrackCount(
  database: D1Database,
  client: SpotifyApiClient,
  task: ResolutionTask,
): Promise<boolean> {
  const artistId = findArtistId(task.subjectUri);
  let offset = task.cursor === null ? 0 : Number(task.cursor);
  let accumulated = task.accumulated;

  for (let page = 0; page < PAGES_PER_TICK; page += 1) {
    const response = await client.getArtistAlbums(artistId, {
      limit: ARTIST_ALBUMS_PAGE_SIZE,
      offset,
    });

    for (const album of response.items) {
      accumulated += album.total_tracks ?? 0;
    }
    offset += response.items.length;

    const isLastPage = response.next === null || response.items.length === 0;
    if (isLastPage) {
      await database
        .prepare(`UPDATE artist SET total_track_count = ? WHERE uri = ?`)
        .bind(accumulated, task.subjectUri)
        .run();
      await completeResolution(database, task);
      return true;
    }
  }

  await advanceResolution(database, task, { cursor: String(offset), accumulated });
  return false;
}
