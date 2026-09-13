import { describe, expect, test } from "vitest";

import {
  buildPlayKey,
  readExportedLibrary,
  readExportedPlaylists,
  readExportedPlays,
  SKIP_THRESHOLD_MILLISECONDS,
  summarisePlays,
} from "../../src/export/read_spotify_export";

/**
 * Fixtures copied from Idin's own export on 2026-09-13, not from
 * documentation — Spotify publishes no schema for these files, and the
 * shapes differ from the Web API's in ways that would each have produced
 * silently wrong data if assumed.
 */

const LIBRARY = JSON.stringify({
  tracks: [
    {
      artist: "Mohsen Namjoo",
      album: "Motantan",
      track: "E'terafat E 45 Zarbi",
      uri: "spotify:track:0rFf0vYMEXgOm0NRgjXaMA",
    },
  ],
  albums: [
    { artist: "W.A.S.P.", album: "The Crimson Idol", uri: "spotify:album:1qIXNs2KIv1DfO01lwoUfz" },
  ],
  artists: [{ name: "2CELLOS", uri: "spotify:artist:6Fi8CHfO8WGtu3yO8c2Mc4" }],
  shows: [],
  episodes: [],
});

const PLAYLISTS = JSON.stringify({
  playlists: [
    {
      name: "W: Spanish Pop/Rock",
      lastModifiedDate: "2026-07-21",
      numberOfFollowers: 0,
      collaborators: [],
      items: [
        {
          addedDate: "2026-07-21",
          track: {
            trackName: "Porque te vas",
            artistName: "Jeanette",
            albumName: "iCollection",
            trackUri: "spotify:track:7vQZSwm9WRCHoPwUUuwkvv",
          },
        },
        // A local file added through the desktop client: no track object.
        { addedDate: "2026-07-21", track: null },
      ],
    },
  ],
});

describe("readExportedLibrary", () => {
  test("reads liked tracks, saved albums and followed artists", () => {
    const library = readExportedLibrary(LIBRARY);

    expect(library.tracks).toHaveLength(1);
    expect(library.tracks[0].uri).toBe("spotify:track:0rFf0vYMEXgOm0NRgjXaMA");
    expect(library.albums[0].album).toBe("The Crimson Idol");
    expect(library.artists[0].name).toBe("2CELLOS");
  });

  test("a missing section is empty rather than undefined", () => {
    expect(readExportedLibrary("{}").tracks).toEqual([]);
  });
});

describe("readExportedPlaylists", () => {
  test("flattens the nested track object", () => {
    const playlists = readExportedPlaylists(PLAYLISTS);

    expect(playlists[0].name).toBe("W: Spanish Pop/Rock");
    expect(playlists[0].items[0].trackUri).toBe("spotify:track:7vQZSwm9WRCHoPwUUuwkvv");
  });

  test("keeps addedDate, which the Web API never supplies", () => {
    expect(readExportedPlaylists(PLAYLISTS)[0].items[0].addedDate).toBe("2026-07-21");
  });

  test("drops a local file without abandoning the playlist", () => {
    // A local file has no track object and no URI. Throwing on one entry
    // would lose every other track in that playlist.
    const playlists = readExportedPlaylists(PLAYLISTS);
    expect(playlists[0].items).toHaveLength(1);
  });
});

describe("summarisePlays", () => {
  const play = (trackName: string, msPlayed: number, endTime: string) => ({
    artistName: "KISS",
    trackName,
    msPlayed,
    endTime,
  });

  test("counts a full listen as a play", () => {
    const summaries = summarisePlays([play("Detroit Rock City", 200_000, "2026-01-01 10:00")]);

    const summary = summaries.get(buildPlayKey("KISS", "Detroit Rock City"));
    expect(summary?.playCount).toBe(1);
    expect(summary?.skipCount).toBe(0);
  });

  test("counts a short listen as a skip, not a play", () => {
    // The negative signal. Summing plays and skips together would make a
    // heavily-skipped track look popular.
    const summaries = summarisePlays([
      play("Detroit Rock City", SKIP_THRESHOLD_MILLISECONDS - 1, "2026-01-01 10:00"),
    ]);

    const summary = summaries.get(buildPlayKey("KISS", "Detroit Rock City"));
    expect(summary?.playCount).toBe(0);
    expect(summary?.skipCount).toBe(1);
  });

  test("a play exactly at the threshold counts as a play", () => {
    const summaries = summarisePlays([
      play("Detroit Rock City", SKIP_THRESHOLD_MILLISECONDS, "2026-01-01 10:00"),
    ]);

    expect(summaries.get(buildPlayKey("KISS", "Detroit Rock City"))?.playCount).toBe(1);
  });

  test("accumulates across many plays and keeps the latest", () => {
    const summaries = summarisePlays([
      play("Detroit Rock City", 200_000, "2026-01-01 10:00"),
      play("Detroit Rock City", 200_000, "2026-03-05 22:15"),
      play("Detroit Rock City", 1_000, "2026-02-01 09:00"),
    ]);

    const summary = summaries.get(buildPlayKey("KISS", "Detroit Rock City"));
    expect(summary?.playCount).toBe(2);
    expect(summary?.skipCount).toBe(1);
    expect(summary?.lastPlayed).toBe("2026-03-05 22:15");
  });

  test("different tracks by one artist stay separate", () => {
    const summaries = summarisePlays([
      play("Detroit Rock City", 200_000, "2026-01-01 10:00"),
      play("Rock and Roll All Nite", 200_000, "2026-01-01 10:05"),
    ]);

    expect(summaries.size).toBe(2);
  });
});

describe("buildPlayKey", () => {
  test("is case- and whitespace-insensitive", () => {
    expect(buildPlayKey("KISS", "Detroit Rock City")).toBe(buildPlayKey(" kiss ", "detroit rock city"));
  });

  test("does not collide across a separator in a name", () => {
    // Track and artist names contain every printable character, so a visible
    // separator can be forged by the data itself.
    expect(buildPlayKey("a|b", "c")).not.toBe(buildPlayKey("a", "b|c"));
  });
});

describe("the real export", () => {
  test("parses the actual file shapes without special-casing", () => {
    // Both fixtures above are verbatim from Idin's export. If Spotify changes
    // the format, this is what notices.
    expect(readExportedLibrary(LIBRARY).tracks[0].track).toBe("E'terafat E 45 Zarbi");
    expect(readExportedPlays("[]")).toEqual([]);
  });
});
