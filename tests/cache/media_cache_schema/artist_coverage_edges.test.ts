import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";

import { prepareMediaCache } from "../../../src/cache/media_cache_store";
import { linkTrackRelations, recordTracks } from "../../../src/cache/record_library_facts";
import type { Track } from "../../../src/providers/media_provider";

/**
 * The edges of "an artist's liked songs, counted once per song".
 *
 * `artist_coverage.test.ts` proves the headline cases. These prove the
 * boundaries: where the same-song rule must NOT fire (unknown length, another
 * artist, a gap past the tolerance) and that a re-read of a track keeps the
 * stored title key current. Everything is written through `recordTracks` and
 * `linkTrackRelations`, as a library read does.
 */

const database = (env as { MEDIA_CACHE: D1Database }).MEDIA_CACHE;
const NOW = Date.parse("2026-09-26T12:00:00Z");

const QUEEN = { uri: "spotify:artist:1dfeR4HaWDbWqFHLkxsg1d", name: "Queen" };
const KISS = { uri: "spotify:artist:07XSN3sPlIlB2L2XNcTwJw", name: "KISS" };
const PINK_FLOYD = { uri: "spotify:artist:0k17h0D3J5VfsdmQ1iZtE9", name: "Pink Floyd" };

function likedTrack(options: {
  uri: string;
  name: string;
  artists: { uri: string; name: string }[];
  durationSeconds: number;
  isrc: string;
}): Track {
  return {
    uri: options.uri,
    inLibrary: true,
    id: options.uri.split(":").pop()!,
    name: options.name,
    artists: options.artists,
    artistNames: options.artists.map((entry) => entry.name),
    albumName: "Some Album",
    albumUri: `spotify:album:${options.uri.split(":").pop()}`,
    albumTrackCount: null,
    durationSeconds: options.durationSeconds,
    isrc: options.isrc,
  };
}

async function like(tracks: Track[]): Promise<void> {
  await recordTracks(database, tracks, { isLiked: true, now: NOW });
  await linkTrackRelations(database, tracks, { now: NOW });
}

async function likedSongCount(artistUri: string): Promise<number> {
  const row = await database
    .prepare(`SELECT liked_track_count FROM artist_coverage WHERE artist_uri = ?`)
    .bind(artistUri)
    .first<{ liked_track_count: number }>();
  if (row === null) {
    throw new Error(`No coverage row for ${artistUri}`);
  }
  return row.liked_track_count;
}

beforeEach(async () => {
  await prepareMediaCache(database);
  for (const table of ["track", "track_artist", "artist", "album", "album_artist"]) {
    await database.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("where the same-song rule must not fire", () => {
  test("two same-title tracks with an unknown duration stay two songs", async () => {
    // The Track type says duration is a number, but a null one can reach the
    // database; the view must treat unknown length as "cannot prove same".
    const unknownDuration = null as unknown as number;
    await like([
      likedTrack({
        uri: "spotify:track:untimed1",
        name: "Bohemian Rhapsody",
        artists: [QUEEN],
        durationSeconds: unknownDuration,
        isrc: "GBUM71029601",
      }),
      likedTrack({
        uri: "spotify:track:untimed2",
        name: "Bohemian Rhapsody",
        artists: [QUEEN],
        durationSeconds: unknownDuration,
        isrc: "GBUM71029602",
      }),
    ]);

    expect(await likedSongCount(QUEEN.uri)).toBe(2);
  });

  test("two same-title tracks with a zero duration stay two songs", async () => {
    // An export row has no length and is recorded with 0; 0 means unknown,
    // so it must not be read as two tracks of identical length.
    await like([
      likedTrack({
        uri: "spotify:track:zero1",
        name: "Bohemian Rhapsody",
        artists: [QUEEN],
        durationSeconds: 0,
        isrc: "GBUM71029601",
      }),
      likedTrack({
        uri: "spotify:track:zero2",
        name: "Bohemian Rhapsody",
        artists: [QUEEN],
        durationSeconds: 0,
        isrc: "GBUM71029602",
      }),
    ]);

    expect(await likedSongCount(QUEEN.uri)).toBe(2);
  });

  test("a track with an unknown duration still counts as itself", async () => {
    await like([
      likedTrack({
        uri: "spotify:track:untimedalone",
        name: "Killer Queen",
        artists: [QUEEN],
        durationSeconds: null as unknown as number,
        isrc: "GBUM71029603",
      }),
    ]);

    expect(await likedSongCount(QUEEN.uri)).toBe(1);
  });

  test("two artists with the same song title and near-equal length each get one", async () => {
    await like([
      likedTrack({
        uri: "spotify:track:angelkiss",
        name: "Angel",
        artists: [KISS],
        durationSeconds: 240.0,
        isrc: "USPR37600201",
      }),
      likedTrack({
        uri: "spotify:track:angelqueen",
        name: "Angel",
        artists: [QUEEN],
        durationSeconds: 241.0,
        isrc: "GBUM71029604",
      }),
    ]);

    expect(await likedSongCount(KISS.uri)).toBe(1);
    expect(await likedSongCount(QUEEN.uri)).toBe(1);
  });

  test("same title with durations more than five seconds apart stays two songs", async () => {
    await like([
      likedTrack({
        uri: "spotify:track:echoeslong",
        name: "Echoes",
        artists: [PINK_FLOYD],
        durationSeconds: 1400.0,
        isrc: "GBN9Y7100001",
      }),
      likedTrack({
        uri: "spotify:track:echoesedit",
        name: "Echoes",
        artists: [PINK_FLOYD],
        durationSeconds: 1405.5,
        isrc: "GBN9Y7100002",
      }),
    ]);

    expect(await likedSongCount(PINK_FLOYD.uri)).toBe(2);
  });

  test("same title with durations exactly five seconds apart is one song", async () => {
    // The near-miss of the case above: the boundary is inclusive.
    await like([
      likedTrack({
        uri: "spotify:track:echoesboundary1",
        name: "Echoes",
        artists: [PINK_FLOYD],
        durationSeconds: 1400.0,
        isrc: "GBN9Y7100003",
      }),
      likedTrack({
        uri: "spotify:track:echoesboundary2",
        name: "Echoes",
        artists: [PINK_FLOYD],
        durationSeconds: 1405.0,
        isrc: "GBN9Y7100004",
      }),
    ]);

    expect(await likedSongCount(PINK_FLOYD.uri)).toBe(1);
  });
});

describe("a re-recorded track", () => {
  test("recording the same uri again with a new name updates its normalised title", async () => {
    const original = likedTrack({
      uri: "spotify:track:money1973",
      name: "Money - 2011 Remastered Version",
      artists: [PINK_FLOYD],
      durationSeconds: 383.0,
      isrc: "GBN9Y1100088",
    });
    await like([original]);
    const before = await database
      .prepare(`SELECT normalised_title FROM track WHERE uri = ?`)
      .bind(original.uri)
      .first<{ normalised_title: string }>();

    await like([{ ...original, name: "Time" }]);
    const after = await database
      .prepare(`SELECT normalised_title FROM track WHERE uri = ?`)
      .bind(original.uri)
      .first<{ normalised_title: string }>();

    expect(before?.normalised_title).toBe("money");
    expect(after?.normalised_title).toBe("time");
  });

  test("a renamed track stops merging with the song it used to match", async () => {
    const money = likedTrack({
      uri: "spotify:track:money1973",
      name: "Money",
      artists: [PINK_FLOYD],
      durationSeconds: 382.8,
      isrc: "GBN9Y7300004",
    });
    const remaster = likedTrack({
      uri: "spotify:track:money2011",
      name: "Money - 2011 Remastered Version",
      artists: [PINK_FLOYD],
      durationSeconds: 383.2,
      isrc: "GBN9Y1100088",
    });
    await like([money, remaster]);
    expect(await likedSongCount(PINK_FLOYD.uri)).toBe(1);

    await like([{ ...remaster, name: "Us and Them" }]);

    expect(await likedSongCount(PINK_FLOYD.uri)).toBe(2);
  });
});
