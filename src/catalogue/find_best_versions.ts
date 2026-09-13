/**
 * Which pressing of each song is the one to keep.
 *
 * A liked track sits on whichever master happened to be playing when it was
 * liked, which over years means a library scattered across originals,
 * remasters and anniversary editions of the same records. This finds where
 * each liked song's best version actually is.
 *
 * **Best is the most recent remaster** — Idin's ruling, and usually the best
 * master on streaming. But it is not simply "the newest release": a newer
 * remaster sometimes drops tracks the older edition carried. So the best
 * version is chosen **per song**, each at its own most recent master, which
 * means a work's best form can span more than one release.
 *
 * Nothing here writes. It reports, and a separate confirmed step acts — an
 * unlike cannot be undone on Spotify, and a wrong merge would silently
 * discard a like.
 */

/** One pressing of one song, as the cache holds it. */
export type SongVersion = {
  trackUri: string;
  songKey: string;
  albumUri: string;
  /** ISO date, as the provider reported it. May be a year alone. */
  releaseDate: string | null;
  isLiked: boolean;
  /** True when Idin has pinned this pressing as the one to keep. */
  isPinned: boolean;
};

/** A liked track that is not on the best available pressing of its song. */
export type VersionUpgrade = {
  songKey: string;
  /** The pressing currently liked. */
  from: SongVersion;
  /** The pressing to move to. */
  to: SongVersion;
};

/**
 * Compare two release dates, newest first.
 *
 * Spotify's dates vary in precision — `1977`, `1977-01`, `1977-01-23` — and
 * string comparison handles all three correctly because the format is
 * big-endian. A missing date sorts last: an undated pressing is never chosen
 * over a dated one, because there is no evidence it is newer.
 */
function compareByNewest(left: SongVersion, right: SongVersion): number {
  if (left.releaseDate === right.releaseDate) {
    return 0;
  }
  if (left.releaseDate === null) {
    return 1;
  }
  if (right.releaseDate === null) {
    return -1;
  }
  return left.releaseDate > right.releaseDate ? -1 : 1;
}

/**
 * The pressing to keep, among versions of one song.
 *
 * A pin wins outright. Idin's ruling: a manual flag "stays with the track
 * until the user undoes it", so no heuristic overrides it — not a newer
 * remaster, not a re-run of this finder. That is what allows the matching
 * rules elsewhere to stay simple, since every case they get wrong can be
 * settled by hand.
 *
 * @param versions - Every known pressing of one song.
 * @returns The pressing to keep, or null when there are none.
 */
export function findBestVersion(versions: SongVersion[]): SongVersion | null {
  if (versions.length === 0) {
    return null;
  }
  const pinned = versions.find((version) => version.isPinned);
  if (pinned !== undefined) {
    return pinned;
  }
  return [...versions].sort(compareByNewest)[0];
}

/**
 * Liked tracks that would be better held on another pressing.
 *
 * Only reports a move when the song is **already liked** somewhere: this
 * relocates existing likes rather than proposing new ones. And it says
 * nothing when the liked pressing is already the best, so a library in good
 * order produces an empty report rather than noise.
 *
 * @param versionsBySong - Every known pressing, grouped by song.
 * @returns One upgrade per liked song that is on the wrong pressing.
 */
export function findVersionUpgrades(
  versionsBySong: Map<string, SongVersion[]>,
): VersionUpgrade[] {
  const upgrades: VersionUpgrade[] = [];

  for (const [songKey, versions] of versionsBySong) {
    const best = findBestVersion(versions);
    if (best === null) {
      continue;
    }
    for (const version of versions) {
      if (version.isLiked && version.trackUri !== best.trackUri) {
        upgrades.push({ songKey, from: version, to: best });
      }
    }
  }

  return upgrades;
}

/**
 * How many upgrades to name individually before summarising.
 *
 * Idin's instruction: *"if too many, just summary, otherwise the items"*. A
 * first run over a long-neglected library can produce hundreds, and a list
 * that long is not read — it is scrolled past, which is worse than a count
 * because it looks like information.
 */
export const MAXIMUM_UPGRADES_TO_LIST = 25;

/**
 * Describe what would change, for a human to rule on.
 *
 * Deliberately a report rather than an action. Moving a like means unliking
 * the old track, which Spotify cannot undo — so this produces words, and a
 * separate confirmed call does the work.
 *
 * @param upgrades - What was found.
 * @param describe - Turns a track URI into something readable.
 * @returns Text naming each upgrade, or summarising when there are many.
 */
export function describeUpgrades(
  upgrades: VersionUpgrade[],
  describe: (version: SongVersion) => string,
): string {
  if (upgrades.length === 0) {
    return "Every liked track is already on the best available version.";
  }

  const heading =
    `${upgrades.length} liked track(s) sit on an older master than the best `
    + `available version.`;

  if (upgrades.length > MAXIMUM_UPGRADES_TO_LIST) {
    const albums = new Set(upgrades.map((upgrade) => upgrade.to.albumUri));
    return (
      `${heading}\n\n`
      + `They span ${albums.size} album(s). That is too many to list — ask for `
      + `a specific album or artist to see the individual moves.`
    );
  }

  const lines = upgrades.map(
    (upgrade) => `  ${describe(upgrade.from)}\n    -> ${describe(upgrade.to)}`,
  );
  return `${heading}\n\n${lines.join("\n")}`;
}
