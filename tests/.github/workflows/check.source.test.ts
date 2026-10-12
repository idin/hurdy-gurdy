import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * These tests check the CI workflow rather than the code.
 *
 * Until the workflow existed, nothing ran `npm run typecheck` (which also
 * compiles the SCHEMAS_MATCH_TYPES drift guard) or the tests, so a type error
 * reached main unseen. A test of the workflow's text cannot prove the
 * workflow goes green on GitHub, but it does stop someone deleting the step
 * that makes it red, and it fails if the workflow is renamed or removed.
 */

const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
const workflowPath = join(repositoryRoot, ".github", "workflows", "check.yml");

function readWorkflow(): string {
  if (!existsSync(workflowPath)) {
    throw new Error(`Expected the CI workflow at ${workflowPath}, but it does not exist.`);
  }
  return readFileSync(workflowPath, "utf8");
}

/** The workflow's lines with comments removed, so a commented-out step does not count. */
function readWorkflowWithoutComments(): string {
  return readWorkflow()
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("the check workflow", () => {
  test("runs on pull requests and on pushes to main", () => {
    const workflow = readWorkflowWithoutComments();
    expect(workflow).toMatch(/^\s*pull_request:/m);
    expect(workflow).toMatch(/^\s*push:[\s\S]*?branches:\s*\[\s*main\s*\]/m);
  });

  test("installs from the lockfile, then typechecks, then runs the tests that need no secrets", () => {
    const workflow = readWorkflowWithoutComments();
    const install = workflow.indexOf("npm ci");
    const typecheck = workflow.indexOf("npm run typecheck");
    const tests = workflow.indexOf("npx vitest run --project worker --project repository");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(typecheck).toBeGreaterThan(install);
    expect(tests).toBeGreaterThan(install);
  });

  test("never runs the integration project, which needs a real Spotify account", () => {
    expect(readWorkflowWithoutComments()).not.toMatch(/--project\s+integration|test:integration/);
  });

  test("makes the gitignored wrangler.jsonc from the example before the worker tests need it", () => {
    const workflow = readWorkflowWithoutComments();
    const copy = workflow.indexOf("cp wrangler.example.jsonc wrangler.jsonc");
    const tests = workflow.indexOf("npx vitest run");
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(copy).toBeLessThan(tests);
  });

  test("uses no secrets", () => {
    expect(readWorkflowWithoutComments()).not.toMatch(/\$\{\{\s*secrets\./);
  });

  test("pins every action to a full commit sha", () => {
    const uses = [...readWorkflowWithoutComments().matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const match of uses) {
      expect(match[1]).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });
});
