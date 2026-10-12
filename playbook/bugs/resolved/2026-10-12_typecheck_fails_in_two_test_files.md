# Typecheck fails: 6 errors in the tests project on origin/main

## What was expected

`npm run typecheck` (`tsc --noEmit -p tsconfig.json && tsc --noEmit -p tests/tsconfig.json`)
exits 0 on `origin/main`.

## What actually happened

`tsc -p tests/tsconfig.json` reports 6 errors and `npm run typecheck` exits non-zero.
Observed on `origin/main` at commit 1371507 (the branch base, identical in content to `origin/main` at 051db16; reproduced again on the branch head, which differs only by this file), after `npm ci`, long types trimmed:

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
`ResolutionPriority` (type at `src/resolver/resolution_queue.ts:108`, field at line 116).

### Group 2: two `MEDIA_CACHE does not exist on type 'Env'` errors

Locations: `tests/cache/views_survive_preparation.test.ts(21,22)` and
`tests/resolver/musicbrainz_resolution_routing.test.ts(22,22)`, both `env.MEDIA_CACHE`.
`src/types.ts:10` declares `MEDIA_CACHE?: D1Database`, but the `Env` the tests see
is the global one generated into the gitignored `worker-configuration.d.ts`.

Checked, twice. (1) With the example config (`npx wrangler types -c wrangler.example.jsonc`,
since plain `npx wrangler types` needs the gitignored `wrangler.jsonc`): all 6 errors
remain; the example declares no D1 binding. (2) With a read-only copy of the owner's real
`wrangler.jsonc` (which declares the `MEDIA_CACHE` D1 binding) and plain `npx wrangler types`:
the generated `worker-configuration.d.ts` does contain `MEDIA_CACHE: D1Database`, yet
`tsc --noEmit -p tests/tsconfig.json` still reports all 6 errors. **So regenerating
the types does not make the 2 errors vanish.** `tests/tsconfig.json` has
`include: ["**/*.ts"]` relative to `tests/`, so the root-level generated file is not part
of the tests project; the `Env` the tests see lacks the binding. Likely fix, not
verified: include the generated file in the tests project, or type the tests' `env`
from `src/types.ts`.

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

## Resolution (appended 2026-10-12)

### Root cause of Group 2 (the two `MEDIA_CACHE` errors)

The tests' `env` (from `cloudflare:test`) is typed `Cloudflare.Env`. That interface is
declared only in the generated, gitignored `worker-configuration.d.ts` at the repository
root, which `tests/tsconfig.json` (`include: ["**/*.ts"]`, relative to `tests/`) never
loads. So the tests saw an empty `Cloudflare.Env` however the file was regenerated.
Including the generated file was tried and rejected: it made `src/index.ts` fail
(`Env` from `src/types.ts` has optional `MEDIA_CACHE`, the generated one requires it),
and its contents depend on each developer's private `wrangler.jsonc`.

### Fix (tests only, so one tester pull request)

- `tests/cloudflare_test_environment.d.ts` makes `Cloudflare.Env` extend the production
  `Env` of `src/types.ts`, so the tests see exactly the bindings the Worker declares and
  nothing depends on a generated file or a private config.
- `tests/resolver/musicbrainz_resolution_routing.test.ts`: `TASK` is typed
  `ResolutionTask` with `RESOLUTION_PRIORITY.BACKFILL` (the value `1` it had), so
  `priority` is not widened to `number` (Group 1).

### Red, before the fix (`npm run typecheck`, with the real `wrangler.jsonc` and a fresh `npx wrangler types`)

```
tests/cache/media_cache_schema/views_survive_preparation.test.ts(21,22): error TS2339: Property 'MEDIA_CACHE' does not exist on type 'Env'.
tests/resolver/musicbrainz_resolution_routing.test.ts(22,22): error TS2339: Property 'MEDIA_CACHE' does not exist on type 'Env'.
tests/resolver/musicbrainz_resolution_routing.test.ts(74,41): error TS2322: ... Type 'number' is not assignable to type 'ResolutionPriority'.
tests/resolver/musicbrainz_resolution_routing.test.ts(80,58): error TS2345: ...
tests/resolver/musicbrainz_resolution_routing.test.ts(93,58): error TS2345: ...
tests/resolver/musicbrainz_resolution_routing.test.ts(105,58): error TS2345: ...
```

### Green, after the fix

```
> hurdy-gurdy@0.18.0 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tests/tsconfig.json

exit=0
```

Also green without the generated `worker-configuration.d.ts` present. Full suite
(`npx vitest run --project worker --project repository --maxWorkers=2`):
41 files, 387 tests passed.
