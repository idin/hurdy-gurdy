# npm ci fails on Linux because the lockfile lacks the Linux optional packages

## What was expected

`npm ci` in the CI workflow (ubuntu runner) installs from `package-lock.json`.

## What happened

The lockfile was generated on macOS, so it lists only the darwin optional
packages of esbuild, lightningcss and rolldown. `npm ci` on Linux refuses.

## Scenario

Any run of `.github/workflows/check.yml` on a pull request. CI run
38241856080 (PR #10), step "Run npm ci":

```
check	Run npm ci	2026-10-12T11:19:10.0633911Z npm error code EUSAGE
check	Run npm ci	2026-10-12T11:19:10.0708152Z npm error Missing: @esbuild/linux-x64@0.28.1 from lock file
check	Run npm ci	2026-10-12T11:19:10.0714908Z npm error Missing: lightningcss-linux-x64-gnu@1.33.0 from lock file
check	Run npm ci	2026-10-12T11:19:10.0721965Z npm error Missing: @rolldown/binding-linux-x64-gnu@1.2.8 from lock file
```

## Fix plan

Regenerate the lockfile so every platform's optional entries are present,
with no change to any resolved version.

## Fix (appended 2026-10-12)

Commit d6137ab added the missing optional platform entries to
`package-lock.json` at the versions their parents already pin. Parsed
before/after: 0 entries changed, 0 removed, 108 added (all `optional`);
`npm ci --dry-run` reports no "Missing". The lockfile carries no `resolved`
or `integrity` fields anywhere, so the added entries match.

Green: CI run 38243104633 (head 3612e06), job `check` passed: `npm ci`,
typecheck, and vitest (worker and repository) all ran.

A second failure sat behind this one: `wrangler.example.jsonc` had no
`d1_databases` entry, so `MEDIA_CACHE` was undefined in CI and 13 test files
failed (run 38242840246). Fixed in 3612e06.
