/**
 * Bringing an existing database up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` creates a table that is absent and leaves one
 * that exists entirely alone — including when the code's idea of that table
 * has since gained columns. So a schema change reaches a fresh database and
 * never reaches a live one.
 *
 * That is not hypothetical. On 2026-09-13 the `track` table gained
 * `play_count`, `skip_count` and `last_played`; the deployed database kept
 * the old shape, and a bulk import failed fourteen chunks in with
 * `no such column: play_count`. The columns were added by hand with
 * `ALTER TABLE`, which fixes that database and nothing else — a second
 * deployment, or a rebuild, would hit it again.
 *
 * This closes that. Migrations are declarative, idempotent, and applied on
 * the same path that creates the schema, so the two can never drift.
 */

/**
 * One additive schema change.
 *
 * Deliberately limited to adding columns and indexes. A migration that
 * rewrites or drops data needs a human deciding when it runs, and putting
 * one here would mean it fires on a cold start with nobody watching.
 */
export type Migration = {
  /** What it does, in words, for whoever reads a failure. */
  description: string;
  /** The statement to run. Must be safe to attempt against an up-to-date database. */
  statement: string;
};

/**
 * Every additive change made since the original schema.
 *
 * **Append only, never edit or reorder.** A database that already ran an
 * entry must see exactly the same list on its next start, or the record of
 * what has been applied stops meaning anything.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    description: "track gains play_count, from the data export's streaming history",
    statement: "ALTER TABLE track ADD COLUMN play_count INTEGER",
  },
  {
    description: "track gains skip_count, plays abandoned under the 30s threshold",
    statement: "ALTER TABLE track ADD COLUMN skip_count INTEGER",
  },
  {
    description: "track gains last_played",
    statement: "ALTER TABLE track ADD COLUMN last_played TEXT",
  },
  {
    description: "track gains song_key, grouping pressings of one recording",
    statement: "ALTER TABLE track ADD COLUMN song_key TEXT",
  },
  {
    description: "album gains work_key, grouping masters of one album",
    statement: "ALTER TABLE album ADD COLUMN work_key TEXT",
  },
  {
    description: "track gains isrc, the cross-service recording identifier",
    statement: "ALTER TABLE track ADD COLUMN isrc TEXT",
  },
];

/**
 * Apply every migration that this database has not seen.
 *
 * Each is attempted and its failure ignored, rather than tracked in a
 * versions table. That is the right trade for *additive* changes: `ALTER
 * TABLE ADD COLUMN` on a column that exists fails harmlessly and changes
 * nothing, so attempting it is cheaper and less breakable than maintaining a
 * ledger that could itself fall out of step with reality.
 *
 * A migration that destroys or rewrites data would need the ledger. None of
 * these do, and the type comment says why none should.
 *
 * @param database - The bound D1 database.
 * @returns How many statements actually changed something, for logging.
 */
export async function applyMigrations(database: D1Database): Promise<number> {
  let applied = 0;

  for (const migration of MIGRATIONS) {
    try {
      await database.prepare(migration.statement).run();
      applied += 1;
    } catch {
      // Already applied. The only failure `ALTER TABLE ADD COLUMN` produces
      // on an up-to-date database is "duplicate column name", and treating
      // that as an error would make every start after the first one fail.
    }
  }

  return applied;
}
