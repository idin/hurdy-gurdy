import { describe, expect, test } from "vitest";

import {
  describeUpgrades,
  findBestVersion,
  findVersionUpgrades,
  MAXIMUM_UPGRADES_TO_LIST,
  type SongVersion,
} from "../../src/catalogue/find_best_versions";

/**
 * The rule that matters most here is the pin.
 *
 * Idin: a manually flagged best version "stays with the track until the user
 * undoes it". Every heuristic in this file is allowed to be simple precisely
 * because a pin can overrule it, so a pin that silently loses to a newer
 * remaster would remove the escape hatch and make the simplicity a problem
 * rather than a choice.
 */

function version(overrides: Partial<SongVersion> & { trackUri: string }): SongVersion {
  return {
    songKey: "animals|40",
    albumUri: "spotify:album:orig",
    releaseDate: "1977-01-23",
    isLiked: false,
    isPinned: false,
    ...overrides,
  };
}

describe("findBestVersion", () => {
  test("prefers the most recent master", () => {
    const best = findBestVersion([
      version({ trackUri: "spotify:track:orig", releaseDate: "1977-01-23" }),
      version({ trackUri: "spotify:track:rmx", releaseDate: "2018-09-07" }),
    ]);

    expect(best?.trackUri).toBe("spotify:track:rmx");
  });

  test("a pin beats a newer master", () => {
    // The escape hatch. If this fails, nothing protects a case the heuristics
    // get wrong.
    const best = findBestVersion([
      version({ trackUri: "spotify:track:orig", releaseDate: "1977-01-23", isPinned: true }),
      version({ trackUri: "spotify:track:rmx", releaseDate: "2018-09-07" }),
    ]);

    expect(best?.trackUri).toBe("spotify:track:orig");
  });

  test("handles Spotify's mixed date precision", () => {
    // Real dates come as 1977, 1977-01 and 1977-01-23 interchangeably.
    const best = findBestVersion([
      version({ trackUri: "spotify:track:a", releaseDate: "1977" }),
      version({ trackUri: "spotify:track:b", releaseDate: "2018-09" }),
      version({ trackUri: "spotify:track:c", releaseDate: "1994-11-03" }),
    ]);

    expect(best?.trackUri).toBe("spotify:track:b");
  });

  test("an undated pressing never wins over a dated one", () => {
    // No evidence it is newer, so it must not be chosen as if it were.
    const best = findBestVersion([
      version({ trackUri: "spotify:track:dated", releaseDate: "1977" }),
      version({ trackUri: "spotify:track:undated", releaseDate: null }),
    ]);

    expect(best?.trackUri).toBe("spotify:track:dated");
  });

  test("returns null rather than throwing on no versions", () => {
    expect(findBestVersion([])).toBeNull();
  });
});

describe("findVersionUpgrades", () => {
  test("reports a like sitting on an older master", () => {
    const upgrades = findVersionUpgrades(
      new Map([
        [
          "animals|40",
          [
            version({ trackUri: "spotify:track:orig", releaseDate: "1977", isLiked: true }),
            version({ trackUri: "spotify:track:rmx", releaseDate: "2018" }),
          ],
        ],
      ]),
    );

    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].from.trackUri).toBe("spotify:track:orig");
    expect(upgrades[0].to.trackUri).toBe("spotify:track:rmx");
  });

  test("says nothing when the liked version is already best", () => {
    // A library in good order produces an empty report, not noise.
    const upgrades = findVersionUpgrades(
      new Map([
        [
          "animals|40",
          [
            version({ trackUri: "spotify:track:orig", releaseDate: "1977" }),
            version({ trackUri: "spotify:track:rmx", releaseDate: "2018", isLiked: true }),
          ],
        ],
      ]),
    );

    expect(upgrades).toHaveLength(0);
  });

  test("ignores songs that are not liked at all", () => {
    // This relocates existing likes; it does not propose new ones.
    const upgrades = findVersionUpgrades(
      new Map([
        [
          "animals|40",
          [
            version({ trackUri: "spotify:track:orig", releaseDate: "1977" }),
            version({ trackUri: "spotify:track:rmx", releaseDate: "2018" }),
          ],
        ],
      ]),
    );

    expect(upgrades).toHaveLength(0);
  });

  test("a pinned song is never proposed for a move", () => {
    const upgrades = findVersionUpgrades(
      new Map([
        [
          "animals|40",
          [
            version({
              trackUri: "spotify:track:orig",
              releaseDate: "1977",
              isLiked: true,
              isPinned: true,
            }),
            version({ trackUri: "spotify:track:rmx", releaseDate: "2018" }),
          ],
        ],
      ]),
    );

    expect(upgrades).toHaveLength(0);
  });

  test("each song is judged on its own master, so one work can span releases", () => {
    // Idin's bonus-track rule: a newer remaster may lack a track the older
    // edition carried, so the best form of a work is not always one release.
    const upgrades = findVersionUpgrades(
      new Map([
        [
          "song one|40",
          [
            version({ trackUri: "spotify:track:o1", releaseDate: "1977", isLiked: true }),
            version({ trackUri: "spotify:track:r1", releaseDate: "2018" }),
          ],
        ],
        [
          "bonus track|60",
          // Only on the older deluxe edition; nothing newer exists.
          [version({ trackUri: "spotify:track:deluxe", releaseDate: "1994", isLiked: true })],
        ],
      ]),
    );

    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].to.trackUri).toBe("spotify:track:r1");
  });
});

describe("describeUpgrades", () => {
  const name = (entry: SongVersion) => entry.trackUri;

  test("says plainly when there is nothing to do", () => {
    expect(describeUpgrades([], name)).toContain("already on the best");
  });

  test("names each move when there are few", () => {
    const report = describeUpgrades(
      [
        {
          songKey: "animals|40",
          from: version({ trackUri: "spotify:track:orig", isLiked: true }),
          to: version({ trackUri: "spotify:track:rmx" }),
        },
      ],
      name,
    );

    expect(report).toContain("spotify:track:orig");
    expect(report).toContain("spotify:track:rmx");
  });

  test("summarises rather than listing when there are many", () => {
    // "if too many, just summary, otherwise the items". A list nobody reads
    // is worse than a count, because it looks like information.
    const many = Array.from({ length: MAXIMUM_UPGRADES_TO_LIST + 1 }, (_, index) => ({
      songKey: `song ${index}`,
      from: version({ trackUri: `spotify:track:old${index}`, isLiked: true }),
      to: version({ trackUri: `spotify:track:new${index}` }),
    }));

    const report = describeUpgrades(many, name);

    expect(report).toContain("too many to list");
    expect(report).not.toContain("spotify:track:old0");
  });
});
