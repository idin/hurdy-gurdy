import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";

import { prepareMediaCache } from "../../src/cache/media_cache_store";

/**
 * The union rules, against real SQL.
 *
 * Every scenario here is one Idin stated. The central one: a like on an
 * album's original and a like on its remaster are two likes of ONE album, not
 * one like of each of two — while the same song liked on both masters is
 * still one like.
 */

const database = (env as { MEDIA_CACHE: D1Database }).MEDIA_CACHE;
const NOW = Date.parse("2026-09-13T12:00:00Z");
const ANIMALS = "animals|studio|5";

async function addAlbum(uri: string, name: string, date: string, tracks: number, workKey: string) {
  await database
    .prepare(`INSERT INTO album VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
    .bind(uri, uri.slice(-4), name, date, tracks, workKey, NOW)
    .run();
}

async function addTrack(uri: string, songKey: string, albumUri: string, isLiked: boolean) {
  await database
    .prepare(`INSERT INTO track VALUES (?, ?, ?, ?, 200000, ?, NULL, ?, ?)`)
    .bind(uri, uri.slice(-6), songKey, albumUri, isLiked ? 1 : 0, songKey, NOW)
    .run();
}

async function likedCount(workKey: string): Promise<number> {
  const row = await database
    .prepare(`SELECT liked_track_count FROM work_coverage WHERE work_key = ?`)
    .bind(workKey)
    .first<{ liked_track_count: number }>();
  return row?.liked_track_count ?? 0;
}

beforeEach(async () => {
  await prepareMediaCache(database);
  for (const table of ["track", "album", "pinned_track"]) {
    await database.prepare(`DELETE FROM ${table}`).run();
  }
  await addAlbum("spotify:album:orig", "Animals", "1977-01-23", 5, ANIMALS);
  await addAlbum("spotify:album:rmx", "Animals (2018 Remix)", "2018-09-07", 5, ANIMALS);
  for (let song = 1; song <= 5; song += 1) {
    await addTrack(`spotify:track:orig${song}`, `song ${song}|40`, "spotify:album:orig", false);
    await addTrack(`spotify:track:rmx${song}`, `song ${song}|40`, "spotify:album:rmx", false);
  }
});

describe("likes pooled across masters", () => {
  test("a like on the original and one on the remaster are two likes of one album", async () => {
    // Idin: "i might have liked one track on one album and another on its
    // remastered, those are two likes of the same album".
    await database.prepare(`UPDATE track SET is_liked = 1 WHERE uri = 'spotify:track:orig3'`).run();
    await database.prepare(`UPDATE track SET is_liked = 1 WHERE uri = 'spotify:track:rmx4'`).run();

    expect(await likedCount(ANIMALS)).toBe(2);
  });

  test("the same song liked on both masters counts once", async () => {
    // Without DISTINCT over song_key this would read as two.
    await database.prepare(`UPDATE track SET is_liked = 1 WHERE uri = 'spotify:track:orig3'`).run();
    await database.prepare(`UPDATE track SET is_liked = 1 WHERE uri = 'spotify:track:rmx3'`).run();

    expect(await likedCount(ANIMALS)).toBe(1);
  });

  test("the work reports one album, not two", async () => {
    const row = await database
      .prepare(`SELECT version_count, total_track_count FROM album_work WHERE work_key = ?`)
      .bind(ANIMALS)
      .first<{ version_count: number; total_track_count: number }>();

    expect(row?.version_count).toBe(2);
    expect(row?.total_track_count).toBe(5);
  });

  test("two different songs on the same master still count separately", async () => {
    // The near-miss: deduplicating too aggressively would collapse these.
    await database.prepare(`UPDATE track SET is_liked = 1 WHERE uri = 'spotify:track:orig1'`).run();
    await database.prepare(`UPDATE track SET is_liked = 1 WHERE uri = 'spotify:track:orig2'`).run();

    expect(await likedCount(ANIMALS)).toBe(2);
  });
});

describe("live works in metrics", () => {
  test("a live work is ignored when a studio version exists", async () => {
    await addAlbum("spotify:album:dstl", "Delicate Sound of Thunder (Live)", "1988", 15, "dst|live|15");
    await addAlbum("spotify:album:dsts", "Delicate Sound of Thunder", "1988", 15, "dst|studio|15");

    const { results } = await database
      .prepare(`SELECT work_key FROM countable_work WHERE work_key LIKE 'dst|%'`)
      .all<{ work_key: string }>();

    expect(results?.map((row) => row.work_key)).toEqual(["dst|studio|15"]);
  });

  test("a live work counts when it is the only version", async () => {
    // Idin: "some live albums don't have a studio version, for those the live
    // version counts".
    await addAlbum("spotify:album:pulse", "Pulse (Live)", "1995", 25, "pulse|live|25");

    const { results } = await database
      .prepare(`SELECT work_key FROM countable_work WHERE work_key LIKE 'pulse|%'`)
      .all<{ work_key: string }>();

    expect(results?.map((row) => row.work_key)).toEqual(["pulse|live|25"]);
  });
});
