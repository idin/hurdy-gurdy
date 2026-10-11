import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";

import { prepareMediaCache } from "../../../src/cache/media_cache_store";
import { linkTrackRelations, recordTracks } from "../../../src/cache/record_library_facts";
import type { Track } from "../../../src/providers/media_provider";

/**
 * An artist's liked-song count, counted once per song.
 *
 * Idin's rule, 2026-09-26: "Money" counts once for Pink Floyd whether it was
 * liked on the original *Dark Side of the Moon*, its 2011 remaster, or both.
 * A remaster usually carries its own ISRC, so the count cannot rest on the
 * ISRC-first `song_key` — it has to recognise the song by title and length.
 *
 * Written through `recordTracks` and `linkTrackRelations`, the path a library
 * read takes, so whatever key the count needs is computed exactly as it is in
 * production rather than typed into the test.
 *
 * ISRCs below are shaped like real ones but are illustrative; what matters is
 * that the two pressings' codes differ, as they do on Spotify.
 */

const database = (env as { MEDIA_CACHE: D1Database }).MEDIA_CACHE;
const NOW = Date.parse("2026-09-26T12:00:00Z");

const PINK_FLOYD = { uri: "spotify:artist:0k17h0D3J5VfsdmQ1iZtE9", name: "Pink Floyd" };
const KISS = { uri: "spotify:artist:07XSN3sPlIlB2L2XNcTwJw", name: "KISS" };
const QUEEN = { uri: "spotify:artist:1dfeR4HaWDbWqFHLkxsg1d", name: "Queen" };
const DAVID_BOWIE = { uri: "spotify:artist:0oSGxfWSnnOXhD2fKuz2Gy", name: "David Bowie" };

function likedTrack(options: {
  uri: string;
  name: string;
  artists: { uri: string; name: string }[];
  albumName: string;
  albumUri: string;
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
    albumName: options.albumName,
    albumUri: options.albumUri,
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

describe("one song, counted once", () => {
  test("Money liked on the original and on the 2011 remaster is one song", async () => {
    await like([
      likedTrack({
        uri: "spotify:track:money1973",
        name: "Money",
        artists: [PINK_FLOYD],
        albumName: "The Dark Side of the Moon",
        albumUri: "spotify:album:dsotm1973",
        durationSeconds: 382.8,
        isrc: "GBN9Y7300004",
      }),
      likedTrack({
        uri: "spotify:track:money2011",
        name: "Money - 2011 Remastered Version",
        artists: [PINK_FLOYD],
        albumName: "The Dark Side of the Moon (2011 Remastered Version)",
        albumUri: "spotify:album:dsotm2011",
        durationSeconds: 383.2,
        isrc: "GBN9Y1100088",
      }),
    ]);

    expect(await likedSongCount(PINK_FLOYD.uri)).toBe(1);
  });

  test("the long and short Detroit Rock City are two songs", async () => {
    // The album cut opens with a radio and car engines; the single is just
    // the music. Idin, 2026-09-13: two different tracks.
    await like([
      likedTrack({
        uri: "spotify:track:drcalbum",
        name: "Detroit Rock City",
        artists: [KISS],
        albumName: "Destroyer",
        albumUri: "spotify:album:destroyer",
        durationSeconds: 317.6,
        isrc: "USPR37600001",
      }),
      likedTrack({
        uri: "spotify:track:drcsingle",
        name: "Detroit Rock City",
        artists: [KISS],
        albumName: "Detroit Rock City (Single Edit)",
        albumUri: "spotify:album:drcsingle",
        durationSeconds: 218.4,
        isrc: "USPR37600099",
      }),
    ]);

    expect(await likedSongCount(KISS.uri)).toBe(2);
  });

  test("a collaboration counts once for each credited artist", async () => {
    await like([
      likedTrack({
        uri: "spotify:track:underpressure",
        name: "Under Pressure",
        artists: [QUEEN, DAVID_BOWIE],
        albumName: "Hot Space",
        albumUri: "spotify:album:hotspace",
        durationSeconds: 248.4,
        isrc: "GBUM71100001",
      }),
      likedTrack({
        uri: "spotify:track:underpressure2011",
        name: "Under Pressure - Remastered 2011",
        artists: [QUEEN, DAVID_BOWIE],
        albumName: "Hot Space (2011 Remaster)",
        albumUri: "spotify:album:hotspace2011",
        durationSeconds: 246.9,
        isrc: "GBUM71029612",
      }),
    ]);

    expect(await likedSongCount(QUEEN.uri)).toBe(1);
    expect(await likedSongCount(DAVID_BOWIE.uri)).toBe(1);
  });
});
