import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  readExportedLibrary,
  readExportedPlaylists,
  readExportedPlays,
  summarisePlays,
} from "../../src/export/read_spotify_export";

/**
 * Runs against Idin's actual export, on this machine.
 *
 * A `.source.test.ts` so it runs in the node project with filesystem access.
 * It is the only check that the readers survive the real files rather than
 * the fixtures copied from them — which is the exact distinction that let a
 * documentation-shaped fixture pass while production threw, on 2026-09-13.
 */

const EXPORT_DIRECTORY =
  "/Users/idin/Library/CloudStorage/GoogleDrive-idin.karuei@gmail.com/My Drive/ai_drive";

const hasExport = existsSync(`${EXPORT_DIRECTORY}/YourLibrary.json`);

describe.skipIf(!hasExport)("the real export files", () => {
  test("YourLibrary.json parses and holds the liked library", () => {
    const library = readExportedLibrary(
      readFileSync(`${EXPORT_DIRECTORY}/YourLibrary.json`, "utf8"),
    );

    expect(library.tracks.length).toBeGreaterThan(2000);
    expect(library.tracks.every((track) => track.uri.startsWith("spotify:track:"))).toBe(true);
    expect(library.artists.length).toBeGreaterThan(50);
  });

  test("Playlist1.json parses and every kept item has a URI", () => {
    const playlists = readExportedPlaylists(
      readFileSync(`${EXPORT_DIRECTORY}/Playlist1.json`, "utf8"),
    );

    expect(playlists.length).toBeGreaterThan(100);
    const items = playlists.flatMap((playlist) => playlist.items);
    expect(items.length).toBeGreaterThan(5000);
    expect(items.every((item) => item.trackUri.startsWith("spotify:track:"))).toBe(true);
  });

  test("the streaming history parses and yields real play counts", () => {
    const plays = [0, 1].flatMap((index) => {
      const path = `${EXPORT_DIRECTORY}/StreamingHistory_music_${index}.json`;
      return existsSync(path) ? readExportedPlays(readFileSync(path, "utf8")) : [];
    });

    expect(plays.length).toBeGreaterThan(10000);

    const summaries = summarisePlays(plays);
    expect(summaries.size).toBeGreaterThan(1000);

    // Every summary must account for every play it saw.
    const counted = [...summaries.values()].reduce(
      (total, summary) => total + summary.playCount + summary.skipCount,
      0,
    );
    expect(counted).toBe(plays.length);
  });
});
