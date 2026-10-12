import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildSync } from "esbuild";
import { describe, expect, test } from "vitest";

import { normaliseReleaseTitle } from "../../src/catalogue/normalise_release_title";

/**
 * Runs `scripts/build_normalised_title_sql.ts` for real on a small rows file.
 *
 * This is a `.source.test.ts` so it runs in the `repository` (Node) project:
 * the `worker` project executes inside workerd, which cannot spawn processes.
 * The script is bundled with esbuild first because it imports its sibling
 * source without file extensions, which plain Node cannot resolve.
 */

const repositoryRoot = join(import.meta.dirname, "..", "..");
const outputDirectory = join(repositoryRoot, "tests", "_output", "build_normalised_title_sql");

function runScript(rows: { uri: string; name: string }[]): { standardOutput: string; standardError: string } {
  mkdirSync(outputDirectory, { recursive: true });
  const bundlePath = join(outputDirectory, "build_normalised_title_sql.mjs");
  buildSync({
    entryPoints: [join(repositoryRoot, "scripts", "build_normalised_title_sql.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const rowsPath = join(outputDirectory, "rows.json");
  writeFileSync(rowsPath, JSON.stringify(rows));
  const result = spawnSync("node", [bundlePath, rowsPath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`script exited ${result.status}: ${result.stderr}`);
  }
  return { standardOutput: result.stdout, standardError: result.stderr };
}

describe("build_normalised_title_sql", () => {
  test("emits one UPDATE per row with the value normaliseReleaseTitle gives", () => {
    const rows = [
      { uri: "spotify:track:money2011", name: "Money - 2011 Remastered Version" },
      { uri: "spotify:track:drcalbum", name: "Detroit Rock City" },
    ];

    const { standardOutput, standardError } = runScript(rows);

    const lines = standardOutput.trimEnd().split("\n");
    expect(lines).toEqual(
      rows.map(
        (row) =>
          `UPDATE track SET normalised_title = '${normaliseReleaseTitle(row.name)}' WHERE uri = '${row.uri}';`,
      ),
    );
    expect(lines[0]).toBe(
      "UPDATE track SET normalised_title = 'money' WHERE uri = 'spotify:track:money2011';",
    );
    expect(standardError).toBe("2 titles\n");
  });

  test("doubles apostrophes in titles and uris so the SQL stays valid", () => {
    const { standardOutput } = runScript([
      { uri: "spotify:track:o'brien", name: "Don't Stop Me Now" },
    ]);

    expect(standardOutput).toBe(
      `UPDATE track SET normalised_title = '${normaliseReleaseTitle("Don't Stop Me Now").replace(/'/g, "''")}' WHERE uri = 'spotify:track:o''brien';\n`,
    );
    expect(standardOutput).toContain("o''brien");
    expect(standardOutput).toContain("don''t");
  });

  test("an empty rows file emits no SQL", () => {
    const { standardOutput, standardError } = runScript([]);

    expect(standardOutput).toBe("");
    expect(standardError).toBe("0 titles\n");
  });
});
