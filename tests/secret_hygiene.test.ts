import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * These tests check the repository rather than the code.
 *
 * A secret scanner looks for things that resemble credentials. It would not
 * have caught the failure that prompted these tests, which was a repository
 * with no `.gitignore` at all — there was no secret to find yet, only a
 * missing floor for one to fall through. That is a structural property, and
 * structure is what is asserted here.
 */

const repositoryRoot = join(import.meta.dirname, "..");

/**
 * Files that must never be committed, whatever they happen to contain today.
 *
 * These are the conventional homes for credentials in this project: `.env`
 * for shared keys, `.dev.vars` for the Workers runtime, `wrangler.jsonc` for
 * a deployment's own configuration.
 */
const MUST_BE_IGNORED = [".env", ".dev.vars"];

/**
 * Run a git command in this repository.
 *
 * @param args - Arguments passed to git.
 * @returns The command's standard output, trimmed.
 */
function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

describe("secret hygiene", () => {
  test("a .gitignore exists", () => {
    // The floor. Without it every other guarantee here is accidental.
    expect(existsSync(join(repositoryRoot, ".gitignore"))).toBe(true);
  });

  test.each(MUST_BE_IGNORED)("%s is ignored", (path) => {
    // `check-ignore` exits non-zero when the path is not ignored, which
    // execFileSync turns into a throw.
    expect(() => git(["check-ignore", "--quiet", path])).not.toThrow();
  });

  test("nothing that should be ignored is already tracked", () => {
    // A .gitignore does nothing for a file that was committed before it was
    // written, and that is the case most likely to go unnoticed.
    const tracked = git(["ls-files"]).split("\n").filter(Boolean);
    const shouldNotBeTracked = tracked.filter((path) => {
      const name = path.split("/").pop() ?? "";
      return (
        name === ".env" ||
        name.startsWith(".env.") ||
        name === ".dev.vars" ||
        name.endsWith(".pem") ||
        name.endsWith(".key")
      );
    });
    expect(shouldNotBeTracked).toEqual([]);
  });

  test("no tracked file contains a credential", () => {
    // A blunt pattern check over the working tree. gitleaks in the pre-commit
    // hook is the thorough version and reads the whole history; this catches
    // the same thing from inside the test suite, so a repository set up
    // without the hook is not left with nothing.
    const credentialPattern =
      /(ghp_[A-Za-z0-9]{20}|github_pat_[A-Za-z0-9_]{20}|sk-[A-Za-z0-9]{32}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

    const tracked = git(["ls-files"]).split("\n").filter(Boolean);
    const offenders = tracked.filter((path) => {
      const fullPath = join(repositoryRoot, path);
      if (!existsSync(fullPath)) {
        return false;
      }
      // This test file necessarily contains the patterns it searches for.
      if (path.endsWith("secret_hygiene.test.ts")) {
        return false;
      }
      return credentialPattern.test(readFileSync(fullPath, "utf8"));
    });

    expect(offenders).toEqual([]);
  });
});
