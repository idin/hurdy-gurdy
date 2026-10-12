# Typecheck fails: 6 errors in the tests project on origin/main

## What was expected

`npm run typecheck` (`tsc --noEmit -p tsconfig.json && tsc --noEmit -p tests/tsconfig.json`)
exits 0 on `origin/main`.

## What actually happened

`tsc -p tests/tsconfig.json` reports 6 errors and `npm run typecheck` exits non-zero.
Observed on `origin/main` (commit 1371507, after `npm ci`), long types trimmed:

```
tests/cache/views_survive_preparation.test.ts(21,22): error TS2339: Property 'MEDIA_CACHE' does not exist on type 'Env'.
tests/resolver/musicbrainz_resolution_routing.test.ts(22,22): error TS2339: Property 'MEDIA_CACHE' does not exist on type 'Env'.
tests/resolver/musicbrainz_resolution_routing.test.ts(74,41): error TS2322: Type '{ kind: "resolve-musicbrainz"; subjectUri: string; priority: number; ... }' is not assignable to type '{ kind: ResolutionKind; subjectUri: string; priority: ResolutionPriority; }'.
tests/resolver/musicbrainz_resolution_routing.test.ts(80,58): error TS2345: Argument of type '{ ... priority: number; ... }' is not assignable to parameter of type 'ResolutionTask'.
tests/resolver/musicbrainz_resolution_routing.test.ts(93,58): error TS2345: (same)
tests/resolver/musicbrainz_resolution_routing.test.ts(105,58): error TS2345: (same)
```

### Group 1: four `priority` errors (lines 74, 80, 93, 105)

The task objects in `tests/resolver/musicbrainz_resolution_routing.test.ts` are built
from the shared `TASK` constant, whose `priority: 1` (line 30) widens to `number`.
It is then not assignable to `ResolutionTask`, whose `priority` is
`ResolutionPriority` (`src/resolver/resolution_queue.ts:108`).

### Group 2: two `MEDIA_CACHE does not exist on type 'Env'` errors

Locations: `tests/cache/views_survive_preparation.test.ts(21,22)` and
`tests/resolver/musicbrainz_resolution_routing.test.ts(22,22)`, both `env.MEDIA_CACHE`.
`src/types.ts:10` declares `MEDIA_CACHE?: D1Database`, but the `Env` the tests see
is the global one generated into the gitignored `worker-configuration.d.ts`.

Checked: I generated that file in the fresh worktree
(`npx wrangler types -c wrangler.example.jsonc`; plain `npx wrangler types` fails
with "No config file detected" because the real `wrangler.jsonc` is gitignored) and
re-ran `tsc --noEmit -p tests/tsconfig.json`. **The two errors did not vanish**: all
6 remain. So a missing generated file is not the whole explanation. What I found:
`wrangler.example.jsonc` declares only the `OAUTH_KV` and `SPOTIFY_TOKENS` bindings and
no D1 binding, so the generated `Env` has no `MEDIA_CACHE`. Whether the owner's real
`wrangler.jsonc` (not in git) declares it, and so whether the errors appear there
too, I did not check. Likely fix, not verified: add the D1 `MEDIA_CACHE` binding to
`wrangler.example.jsonc`, or type the tests' `env` from `src/types.ts`.

## Scenario that triggers it

```
npm ci
npm run typecheck
```

## Regression test

The typecheck itself: `npm run typecheck` is red now and must exit 0. No separate
test is added, since the failure is a compile error that no runtime test can express.

## Fix (for the builder)

Group 1: type the literals in `tests/resolver/musicbrainz_resolution_routing.test.ts`
as `ResolutionPriority` (or `ResolutionTask`) so `priority` is not widened.
Group 2: see the findings above. A tester may edit test files, but this is left to
the builder.
