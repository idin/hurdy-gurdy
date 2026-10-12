import type { Env as ProductionEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    /**
     * The `env` that `cloudflare:test` hands a test, typed as the production
     * `Env` in `src/types.ts`.
     *
     * Without this the tests see only what `worker-configuration.d.ts` declares,
     * and that file is generated from the gitignored `wrangler.jsonc` and lives
     * outside the tests project, so a binding such as `MEDIA_CACHE` was missing
     * from `env` however the types were regenerated. Extending the production
     * type keeps the tests' view of the bindings identical to the Worker's.
     */
    interface Env extends ProductionEnv {}
  }
}
