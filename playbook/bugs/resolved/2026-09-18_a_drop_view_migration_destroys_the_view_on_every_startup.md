# A DROP VIEW migration destroys the view on every startup

## What was expected

`DROP VIEW IF EXISTS track_plays` was added to `MIGRATIONS` on 2026-09-18 so
that a live database holding the *old* `track_plays` definition — which read
counts out of `song_plays` — would discard it and pick up the new one, which
computes every listening metric from `play` rows. `CREATE VIEW IF NOT EXISTS`
leaves an existing view alone, so without a drop the old definition would
survive forever.

## What actually happened

**The view is gone from the live database.**

```
no such table: track_plays: SQLITE_ERROR [code: 7500]
```

Every query against the metrics — `mean_completion_ratio`,
`duration_weighted_completion`, `skip_ratio`, all of it — fails.

## The cause

`prepareMediaCache` in `src/cache/media_cache_store.ts` runs the two steps in
this order:

```ts
await database.batch(MEDIA_CACHE_SCHEMA.map(...));   // line 46 — CREATEs the view
await applyMigrations(database);                      // line 51 — DROPs it
```

So on every cold start the schema step creates `track_plays` and the migration
step immediately destroys it. The view exists only in the window between those
two lines, and the database is left without it.

This is not a one-time casualty of a single deploy. **It happens on every
startup**, so the view can never survive.

### Why the migration list's own rules should have caught this

`apply_migrations.ts` states the constraint plainly in its type comment:

> Deliberately limited to adding columns and indexes. A migration that
> rewrites or drops data needs a human deciding when it runs.

The `DROP VIEW` entry was added with a comment arguing the rule did not apply
because "a view holds no data". That is true and irrelevant: the problem is
not data loss, it is that **migrations run after schema creation**, so any
migration that removes something the schema creates undoes that creation
unconditionally. The rule's reasoning was examined; its ordering consequence
was not.

## Proposed fix

Remove the `DROP VIEW` migration entirely and make view definitions
self-replacing instead. Two options:

1. **`CREATE VIEW` preceded by `DROP VIEW` inside `MEDIA_CACHE_SCHEMA`
   itself**, as an adjacent pair. The drop then runs *before* its own create
   on every start, which is idempotent and leaves the view present. This also
   means a changed view definition reaches a live database automatically,
   which is the property the migration was reaching for.
2. Keep the migration but move `applyMigrations` **before** the schema batch.
   Rejected: migrations that add columns must run against tables that already
   exist, so this breaks the additive case to fix the view case.

Option 1. Views are cheap to rebuild, hold nothing, and are the only schema
objects whose definition can change in place — so they are exactly the thing
that should be dropped and recreated every time rather than guarded by
`IF NOT EXISTS`.

## Regression test

A test that runs `prepareMediaCache` twice against one database and asserts
`track_plays` is queryable afterwards. It fails today, because the second run
leaves the view dropped — and would also have failed on the first.
