/**
 * Every view must exist after the cache is prepared, and after it is prepared
 * again.
 *
 * The bug this guards: `prepareMediaCache` creates the schema and then runs
 * migrations, in that order. A `DROP VIEW IF EXISTS track_plays` entry was
 * added to the migration list so a live database would discard the view's old
 * definition — and since it ran *after* the create, it destroyed the view on
 * every single startup. The metrics were unqueryable in production while
 * every unit test passed, because no test had ever asked whether the views
 * were still there afterwards.
 *
 * See `docs/bugs/resolved/2026-09-18_a_drop_view_migration_destroys_the_view_on_every_startup.md`.
 */

import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { prepareMediaCache } from "../../src/cache/media_cache_store";

const database = env.MEDIA_CACHE as D1Database;

/**
 * Every view the schema defines.
 *
 * Listed explicitly rather than read back from `sqlite_master`, so a view
 * that silently stops being created fails this test instead of quietly
 * shrinking the list it is compared against.
 */
const EXPECTED_VIEWS = [
  "track_plays",
  "artist_coverage",
  "album_coverage",
  "work_coverage",
  "countable_work",
  "album_work",
  "track_playlist_membership",
];

describe("views survive preparation", () => {
  test("every view is queryable after preparing once", async () => {
    await prepareMediaCache(database);

    for (const view of EXPECTED_VIEWS) {
      // A view that does not exist throws here rather than returning empty,
      // which is the distinction that matters: an empty result is fine, a
      // missing view is not.
      const result = await database.prepare(`SELECT * FROM ${view} LIMIT 1`).all();
      expect(result.success, `${view} should be queryable`).toBe(true);
    }
  });

  test("every view is still queryable after preparing again", async () => {
    // The real failure mode. `prepareMediaCache` memoises per database, so a
    // second call in one process is a no-op — but a Durable Object restart is
    // a fresh process against the same live database, which is exactly what
    // the migration step ran against. Forcing both steps again reproduces it.
    await prepareMediaCache(database);
    const { applyMigrations } = await import("../../src/cache/apply_migrations");
    const { MEDIA_CACHE_SCHEMA } = await import("../../src/cache/media_cache_schema");
    await database.batch(MEDIA_CACHE_SCHEMA.map((statement) => database.prepare(statement)));
    await applyMigrations(database);

    for (const view of EXPECTED_VIEWS) {
      const result = await database.prepare(`SELECT * FROM ${view} LIMIT 1`).all();
      expect(result.success, `${view} should survive a second preparation`).toBe(true);
    }
  });

  test("no migration drops something the schema creates", async () => {
    // The general rule, checked structurally rather than by outcome. A DROP
    // in the migration list always runs after the schema batch, so anything
    // it removes is removed unconditionally on every startup.
    const { MIGRATIONS } = await import("../../src/cache/apply_migrations");
    const dropping = MIGRATIONS.filter((migration) =>
      /\bDROP\b/i.test(migration.statement),
    );

    expect(
      dropping.map((migration) => migration.description),
      "migrations run after schema creation, so a DROP here undoes it every time",
    ).toEqual([]);
  });
});
