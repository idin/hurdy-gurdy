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

import type { MediaProvider } from "../providers/media_provider";
import {
  findRecordingByIsrc,
  findRecordingDetail,
  isMusicBrainzBusy,
  searchRecording,
  type MusicBrainzRecording,
} from "../catalogue/musicbrainz_client";
import {
  isListenBrainzRateLimited,
  mapRecording,
} from "../catalogue/listenbrainz_client";
import { stripMasterSuffixes } from "../catalogue/normalise_release_title";
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
 * Eight, against a fifty-subrequest budget. An alarm tick does not share its
 * budget with a user's request — it is its own invocation — so the earlier
 * caution about starving a caller did not apply. The remaining headroom
 * covers the queue reads around the crawl.
 */
export const PAGES_PER_TICK = 8;

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
  provider?: MediaProvider,
  listenBrainzToken?: string,
): Promise<{ outcome: "completed" | "advanced" | "failed" }> {
  try {
    if (task.kind === "backfill-liked-tracks") {
      if (provider === undefined) {
        return { outcome: "failed" };
      }
      const finished = await advanceLikedTracksBackfill(database, provider, task);
      return { outcome: finished ? "completed" : "advanced" };
    }
    if (task.kind === "resolve-musicbrainz") {
      await resolveMusicBrainzIdentity(database, task, listenBrainzToken);
      return { outcome: "completed" };
    }
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

/**
 * How many library pages to pull in one tick.
 *
 * Each page is one request plus the writes recording its facts, so this is
 * the coarse dial on how fast a backfill completes. Six pages of fifty is
 * three hundred tracks a tick — a 2,282-track library in eight ticks.
 */
export const LIBRARY_PAGES_PER_TICK = 6;

/**
 * Read the next stretch of the liked library into the cache.
 *
 * Goes through the provider rather than the raw client, so every page passes
 * the decorator's recording path — the facts, the artist links and the
 * onward enqueueing all happen exactly as they do for a library read someone
 * asked for. Duplicating that here would be a second implementation of it,
 * and the two would drift.
 *
 * @returns True when the whole library has been read.
 */
async function advanceLikedTracksBackfill(
  database: D1Database,
  provider: MediaProvider,
  task: ResolutionTask,
): Promise<boolean> {
  let cursor = task.cursor ?? undefined;

  for (let page = 0; page < LIBRARY_PAGES_PER_TICK; page += 1) {
    const result = await provider.getLikedTracks({ cursor });

    if (result.nextCursor === null) {
      await completeResolution(database, task);
      return true;
    }
    cursor = result.nextCursor;
  }

  await advanceResolution(database, task, {
    cursor: cursor ?? "0",
    accumulated: task.accumulated,
  });
  return false;
}

/**
 * Fill in one track's MusicBrainz identity.
 *
 * **ListenBrainz first, MusicBrainz only for the work relation.** Both serve
 * the same catalogue, but their rate limits differ by two orders of
 * magnitude: MusicBrainz documents one request per second globally per IP and
 * in practice refused sustained traffic at 1.1s, 2s and 4s spacing, while
 * ListenBrainz allows 30 requests per rolling nine seconds.
 *
 * That difference is why this function was rewritten on 2026-09-18. It had
 * called MusicBrainz directly since it was written, which is why 1,979 queued
 * tracks would have taken over half an hour of unbroken 503-prone crawling —
 * and why `listenbrainz_client.ts` existed, unused, having been built for
 * exactly this.
 *
 * The division of labour:
 *
 * | Step | Service | Why |
 * | --- | --- | --- |
 * | name → recording MBID | ListenBrainz `metadata/lookup` | Fast, and built for messy names |
 * | recording MBID → work | MusicBrainz `recording?inc=work-rels` | ListenBrainz does not return it |
 *
 * The second step is skipped entirely when the first misses, so a miss costs
 * one fast request rather than one slow one.
 *
 * Marks the task complete **including when there is no work relation**. That
 * absence is an answer: recording-to-work is among the least complete
 * relations in a crowd-sourced database, and retrying a track whose link
 * simply does not exist would rediscover nothing, forever.
 *
 * A rate-limit refusal is different and is allowed to throw, so the task is
 * retried: it means the question was never asked rather than answered with
 * silence.
 */
async function resolveMusicBrainzIdentity(
  database: D1Database,
  task: ResolutionTask,
  listenBrainzToken?: string,
): Promise<void> {
  const row = await database
    .prepare(
      `SELECT t.isrc, t.name, t.duration_seconds, t.recording_mbid,
              MIN(a.name) AS artist_name
         FROM track t
         LEFT JOIN track_artist ta ON ta.track_uri = t.uri
         LEFT JOIN artist a ON a.uri = ta.artist_uri
        WHERE t.uri = ?
        GROUP BY t.uri`,
    )
    .bind(task.subjectUri)
    .first<{
      isrc: string | null;
      name: string;
      duration_seconds: number | null;
      recording_mbid: string | null;
      artist_name: string | null;
    }>();

  if (row === null) {
    await completeResolution(database, task);
    return;
  }

  try {
    // Already identified: the only thing left to fetch is the composition.
    // Re-running the name lookup would spend a request rediscovering an
    // answer already stored — which matters because a bulk pass over
    // already-resolved tracks is exactly how this task gets re-enqueued.
    if (row.recording_mbid !== null) {
      const detail = await findRecordingDetail(row.recording_mbid);
      await writeRecordingIdentity(database, task.subjectUri, detail);
      await completeResolution(database, task);
      return;
    }

    let recordingMbid: string | null = null;

    // ListenBrainz first: 30 requests per nine seconds against MusicBrainz's
    // one per second, and its mapper is built for exactly the mis-spelled,
    // differently-punctuated names a real library contains.
    if (listenBrainzToken !== undefined && row.artist_name !== null) {
      const mapped = await mapRecording(
        { artistName: row.artist_name, recordingName: row.name },
        listenBrainzToken,
      );
      recordingMbid = mapped?.recordingMbid ?? null;

      // A master marker in the title is the single largest cause of a miss.
      // Measured over 300 real tracks on 2026-09-18: of 42 misses, the
      // remaster-suffixed ones all resolved once the suffix was gone —
      // "Helter Skelter - Remastered 2009" misses, "Helter Skelter" hits.
      //
      // Retried only on a miss, so a title that already matched costs
      // nothing, and only when stripping actually changed something.
      if (recordingMbid === null) {
        const stripped = stripMasterSuffixes(row.name);
        if (stripped !== row.name) {
          const retried = await mapRecording(
            { artistName: row.artist_name, recordingName: stripped },
            listenBrainzToken,
          );
          recordingMbid = retried?.recordingMbid ?? null;
        }
      }
    }

    // MusicBrainz only when ListenBrainz could not be used or did not match.
    // Its ISRC index is markedly less complete than the database itself —
    // "Ace of Spades" has no ISRC entry at all — so a miss falls back to
    // searching by title, artist and length rather than giving up.
    if (recordingMbid === null) {
      let recording = row.isrc == null ? null : await findRecordingByIsrc(row.isrc);
      if (recording === null && row.artist_name !== null && row.duration_seconds !== null) {
        recording = await searchRecording({
          title: row.name,
          artistName: row.artist_name,
          durationSeconds: row.duration_seconds,
        });
      }
      if (recording !== null) {
        await writeRecordingIdentity(database, task.subjectUri, recording);
      }
      await completeResolution(database, task);
      return;
    }

    // ListenBrainz returns the recording but never the work relation, so the
    // composition still needs one MusicBrainz call. It is the only one made
    // on this path, and only for tracks that actually matched.
    const detail = await findRecordingDetail(recordingMbid);
    await writeRecordingIdentity(database, task.subjectUri, detail);
    await completeResolution(database, task);
  } catch (error) {
    if (isMusicBrainzBusy(error) || isListenBrainzRateLimited(error)) {
      // Rate-limited: the question was never asked, so it is not answered.
      throw error;
    }
    // Anything else is an answer — the catalogue does not know this track.
    await completeResolution(database, task);
  }
}

/**
 * Write a resolved recording's identity onto the track.
 *
 * Extracted because both the ListenBrainz and MusicBrainz paths end here, and
 * two copies of an UPDATE that names four columns is two places for them to
 * drift apart.
 *
 * @param database - Where the cache lives.
 * @param trackUri - The track being identified.
 * @param recording - What the catalogue returned.
 */
async function writeRecordingIdentity(
  database: D1Database,
  trackUri: string,
  recording: MusicBrainzRecording,
): Promise<void> {
  await database
    .prepare(`UPDATE track SET recording_mbid = ?, work_mbid = ?, work_title = ? WHERE uri = ?`)
    .bind(recording.mbid, recording.workMbid, recording.workTitle, trackUri)
    .run();
}
