import { describe, expect, test } from "vitest";

import {
  type TypeEquality,
  SCHEMAS_MATCH_TYPES,
  TRACK_PAGE_SCHEMA,
} from "../../src/cache/cached_payload_schemas";

/**
 * The schemas decide whether a cached page is served, so each has to accept
 * what today's code writes and refuse what older code wrote. The drift guard
 * decides whether a schema still matches its type, so it has to be shown to
 * discriminate — a pass, a genuine fail, and the near-misses that a looser
 * check would wave through.
 */

const CURRENT_TRACK = {
  uri: "spotify:track:0vFOzaXqZHahrZp6enQwQb",
  inLibrary: true,
  id: "0vFOzaXqZHahrZp6enQwQb",
  name: "Money",
  artists: [{ uri: "spotify:artist:0k17h0D3J5VfsdmQ1iZtE9", name: "Pink Floyd" }],
  artistNames: ["Pink Floyd"],
  albumName: "The Dark Side of the Moon",
  albumUri: "spotify:album:4LH4d3cOWNNsVw41Gqt2kv",
  albumTrackCount: 10,
  durationSeconds: 382.826,
  isrc: "GBN9Y1100088",
};

function buildPage(items: unknown[]) {
  return { items, nextCursor: null, total: items.length };
}

describe("the track page schema", () => {
  test("accepts a page as today's code writes it", () => {
    expect(TRACK_PAGE_SCHEMA.safeParse(buildPage([CURRENT_TRACK])).success).toBe(true);
  });

  test("accepts a local file, which Spotify sends with a null id", () => {
    // Refusing this once made every playlist holding a local file refetch on
    // every read.
    const localFile = {
      ...CURRENT_TRACK,
      id: null,
      uri: "spotify:local:David+Wise:Donkey+Kong+Country%3A+Tropical+Freeze:Snomads+Island:127",
      artists: [],
      artistNames: ["David Wise"],
      albumUri: null,
      isrc: null,
    };
    expect(TRACK_PAGE_SCHEMA.safeParse(buildPage([localFile])).success).toBe(true);
  });

  test("accepts a track with no ISRC, which Spotify sends as null", () => {
    const localFile = { ...CURRENT_TRACK, isrc: null, albumTrackCount: null };
    expect(TRACK_PAGE_SCHEMA.safeParse(buildPage([localFile])).success).toBe(true);
  });

  test("refuses a page from before durationSeconds, which stored milliseconds", () => {
    const { durationSeconds: _, ...withoutSeconds } = CURRENT_TRACK;
    const beforeSeconds = { ...withoutSeconds, durationMs: 382826 };
    expect(TRACK_PAGE_SCHEMA.safeParse(buildPage([beforeSeconds])).success).toBe(false);
  });

  test("refuses a page from before ISRC, where the field is absent rather than null", () => {
    const { isrc: _, albumTrackCount: __, ...beforeIsrc } = CURRENT_TRACK;
    expect(TRACK_PAGE_SCHEMA.safeParse(buildPage([beforeIsrc])).success).toBe(false);
  });

  test("refuses the whole page when only one of its tracks is old", () => {
    const { durationSeconds: _, ...oldTrack } = CURRENT_TRACK;
    expect(TRACK_PAGE_SCHEMA.safeParse(buildPage([CURRENT_TRACK, oldTrack])).success).toBe(false);
  });
});

describe("the drift guard", () => {
  test("every schema matches the type it guards", () => {
    expect(SCHEMAS_MATCH_TYPES).toEqual({
      track: true,
      artist: true,
      album: true,
      playlist: true,
      trackPage: true,
      artistPage: true,
      albumPage: true,
      playlistPage: true,
    });
  });

  // Checked by the compiler through `npm run typecheck`: each annotation
  // below only compiles if the guard answers as stated. The runtime assertion
  // records the same answers so the test also reads as a claim.

  type Membership = { uri: string; inLibrary: boolean };
  type FlatTrack = { uri: string; inLibrary: boolean; isrc: string | null };

  test("an intersection and a flat object with the same fields are equal", () => {
    // The case that made the first version of the guard fire on correct code.
    const answer: TypeEquality<Membership & { isrc: string | null }, FlatTrack> = true;
    expect(answer).toBe(true);
  });

  test("a missing field is a difference", () => {
    const answer: TypeEquality<Membership, FlatTrack> = false;
    expect(answer).toBe(false);
  });

  test("a field that became nullable is a difference", () => {
    const answer: TypeEquality<Membership & { isrc: string }, FlatTrack> = false;
    expect(answer).toBe(false);
  });

  test("an optional field is not the same as a nullable required one", () => {
    // The near-miss: `isrc?:` accepts an absent field, which is exactly the
    // old-shape payload the schema exists to refuse.
    const answer: TypeEquality<Membership & { isrc?: string | null }, FlatTrack> = false;
    expect(answer).toBe(false);
  });

  test("a difference nested inside an array is still a difference", () => {
    const answer: TypeEquality<
      { artists: { uri: string; name: string }[] },
      { artists: { uri: string }[] }
    > = false;
    expect(answer).toBe(false);
  });
});
