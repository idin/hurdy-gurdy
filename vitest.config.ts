import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Two kinds of test, matching `other-memory`'s split minus its third
 * project: `worker` holds the logic tests, running inside workerd so
 * `crypto.subtle` (needed for PKCE) behaves exactly as it does in
 * production. `repository` holds tests that inspect the repo itself.
 *
 * No `integration` project yet — those would need a real Spotify account
 * and OAuth app to run against, which this package does not have configured.
 * Add it the same way `other-memory`'s exists once that credential is set up.
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "worker",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/**/*.source.test.ts", "tests/secret_hygiene.test.ts"],
        },
      },
      {
        test: {
          name: "repository",
          environment: "node",
          include: ["tests/secret_hygiene.test.ts", "tests/**/*.source.test.ts"],
        },
      },
    ],
  },
});
