/**
 * Work the resolver owes, ordered by how much it matters.
 *
 * Some facts cannot be fetched while a caller waits. An artist's total track
 * count means paging every release they have — Spotify caps
 * `/artists/{id}/albums` at ten per page, and one artist in Idin's library has
 * 312 releases, so that single number is 32 requests against a Worker budget
 * of 50 for the whole invocation. Verified on the live API, 2026-09-13.
 *
 * So the work is queued and drained in the background, and a caller gets a
 * `null` denominator until it lands rather than waiting on a crawl. The
 * numerators — what the library actually holds — are already there.
 *
 * The queue is a table rather than an in-memory list because a Worker isolate
 * does not outlive a request, and work that vanishes on eviction would never
 * finish.
 */

/**
 * What kind of work an entry represents.
 *
 * Kept narrow deliberately. A queue that accepts arbitrary jobs becomes a
 * general task runner, and then nobody can say what it will do next.
 */
export type ResolutionKind =
  /** Count an artist's releases. One request; `total` arrives on page one. */
  | "artist-album-count"
  /** Sum an artist's track counts. As many requests as they have pages. */
  | "artist-track-count";

/**
 * How urgent a piece of work is. Lower drains first.
 *
 * The tiers exist because the queue will usually be long — a first library
 * scan enqueues thousands of artists — and an artist the user just asked
 * about should not wait behind them.
 */
export const RESOLUTION_PRIORITY = {
  /** Something the user is looking at right now. */
  ASKED_FOR: 0,
  /** A followed artist: the spine of the library. */
  FOLLOWED_ARTIST: 1,
  /** An artist with liked tracks, but not followed. */
  HAS_LIKED_TRACKS: 2,
  /** Seen once, in a search result. May never matter. */
  SEEN_IN_PASSING: 3,
} as const;

/** A priority value, from `RESOLUTION_PRIORITY`. */
export type ResolutionPriority =
  (typeof RESOLUTION_PRIORITY)[keyof typeof RESOLUTION_PRIORITY];

/** One piece of outstanding work. */
export type ResolutionTask = {
  kind: ResolutionKind;
  /** What the work is about — an artist URI, for both current kinds. */
  subjectUri: string;
  priority: ResolutionPriority;
  /**
   * Where a multi-page crawl got to, so it resumes rather than restarting.
   *
   * A 32-page artist cannot be done in one invocation, and beginning again
   * each time would mean never finishing.
   */
  cursor: string | null;
  /** Running total across the pages crawled so far. */
  accumulated: number;
  /** How many times this has been attempted and failed. */
  attempts: number;
};

/**
 * How many failures before a task is dropped.
 *
 * A permanently failing task — a deleted artist, a region-locked one — would
 * otherwise hold the head of its priority tier forever and starve everything
 * behind it.
 */
export const MAXIMUM_ATTEMPTS = 3;

/** The table this queue lives in. Created by the cache schema. */
export const RESOLUTION_QUEUE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS resolution_queue (
     kind         TEXT NOT NULL,
     subject_uri  TEXT NOT NULL,
     priority     INTEGER NOT NULL,
     cursor       TEXT,
     accumulated  INTEGER NOT NULL DEFAULT 0,
     attempts     INTEGER NOT NULL DEFAULT 0,
     enqueued_at  INTEGER NOT NULL,
     PRIMARY KEY (kind, subject_uri)
   )`,

  // The drain order. Without this index every tick sorts the whole table,
  // which is the one query that runs most often.
  `CREATE INDEX IF NOT EXISTS resolution_queue_drain_order
     ON resolution_queue (priority, enqueued_at)`,
];

/**
 * Add work, or raise its priority if it is already queued.
 *
 * Priority is lowered numerically, never raised: an artist queued as seen-in-
 * passing and then asked for directly must jump the queue, while one already
 * urgent must not be demoted by a later casual sighting.
 *
 * @param database - Where the queue lives.
 * @param tasks - What to enqueue.
 * @param now - Epoch milliseconds, used to break priority ties by age.
 */
export async function enqueueResolutions(
  database: D1Database,
  tasks: { kind: ResolutionKind; subjectUri: string; priority: ResolutionPriority }[],
  now: number,
): Promise<void> {
  if (tasks.length === 0) {
    return;
  }
  const statements = tasks.map((task) =>
    database
      .prepare(
        `INSERT INTO resolution_queue (kind, subject_uri, priority, enqueued_at)
           VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, subject_uri) DO UPDATE SET
           priority = MIN(resolution_queue.priority, excluded.priority)`,
      )
      .bind(task.kind, task.subjectUri, task.priority, now),
  );
  await database.batch(statements);
}

/**
 * Take the next piece of work, highest priority first, oldest first within a
 * tier.
 *
 * Does not remove the task — a crawl that needs more pages must stay queued
 * with its cursor advanced. `completeResolution` removes it.
 *
 * @param database - Where the queue lives.
 * @returns The next task, or null when there is nothing to do.
 */
export async function findNextResolution(
  database: D1Database,
): Promise<ResolutionTask | null> {
  const row = await database
    .prepare(
      `SELECT kind, subject_uri, priority, cursor, accumulated, attempts
         FROM resolution_queue
        WHERE attempts < ?
        ORDER BY priority ASC, enqueued_at ASC
        LIMIT 1`,
    )
    .bind(MAXIMUM_ATTEMPTS)
    .first<{
      kind: ResolutionKind;
      subject_uri: string;
      priority: ResolutionPriority;
      cursor: string | null;
      accumulated: number;
      attempts: number;
    }>();

  return row === null
    ? null
    : {
        kind: row.kind,
        subjectUri: row.subject_uri,
        priority: row.priority,
        cursor: row.cursor,
        accumulated: row.accumulated,
        attempts: row.attempts,
      };
}

/**
 * Record progress on a crawl that has more pages to go.
 *
 * @param database - Where the queue lives.
 * @param task - The task being advanced.
 * @param progress.cursor - Where to resume.
 * @param progress.accumulated - Running total so far.
 */
export async function advanceResolution(
  database: D1Database,
  task: ResolutionTask,
  progress: { cursor: string; accumulated: number },
): Promise<void> {
  await database
    .prepare(
      `UPDATE resolution_queue SET cursor = ?, accumulated = ?, attempts = 0
         WHERE kind = ? AND subject_uri = ?`,
    )
    // attempts resets on progress: a task that is moving is not failing, and
    // a long crawl must not be dropped for taking many ticks.
    .bind(progress.cursor, progress.accumulated, task.kind, task.subjectUri)
    .run();
}

/**
 * Remove finished work.
 *
 * @param database - Where the queue lives.
 * @param task - The task that is done.
 */
export async function completeResolution(
  database: D1Database,
  task: ResolutionTask,
): Promise<void> {
  await database
    .prepare(`DELETE FROM resolution_queue WHERE kind = ? AND subject_uri = ?`)
    .bind(task.kind, task.subjectUri)
    .run();
}

/**
 * Record a failed attempt.
 *
 * After `MAXIMUM_ATTEMPTS` the task stops being selected, rather than being
 * deleted — a row that is visibly stuck is diagnosable, and one that silently
 * vanished is not.
 *
 * @param database - Where the queue lives.
 * @param task - The task that failed.
 */
export async function recordResolutionFailure(
  database: D1Database,
  task: ResolutionTask,
): Promise<void> {
  await database
    .prepare(
      `UPDATE resolution_queue SET attempts = attempts + 1
         WHERE kind = ? AND subject_uri = ?`,
    )
    .bind(task.kind, task.subjectUri)
    .run();
}

/**
 * How much work is outstanding, by priority tier.
 *
 * Exposed so a tool can answer "is the catalogue still filling in?" — a
 * denominator that is null because the crawl has not reached it yet is a
 * different situation from one that is null because the crawl is stuck.
 *
 * @param database - Where the queue lives.
 * @returns Pending and stuck counts.
 */
export async function countPendingResolutions(
  database: D1Database,
): Promise<{ pending: number; stuck: number }> {
  const row = await database
    .prepare(
      `SELECT
         COUNT(CASE WHEN attempts < ? THEN 1 END) AS pending,
         COUNT(CASE WHEN attempts >= ? THEN 1 END) AS stuck
       FROM resolution_queue`,
    )
    .bind(MAXIMUM_ATTEMPTS, MAXIMUM_ATTEMPTS)
    .first<{ pending: number; stuck: number }>();
  return { pending: row?.pending ?? 0, stuck: row?.stuck ?? 0 };
}
