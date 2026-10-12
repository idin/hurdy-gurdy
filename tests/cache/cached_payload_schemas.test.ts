import { describe, expect, test } from "vitest";

import { type TypeEquality, TRACK_PAGE_SCHEMA } from "../../src/cache/cached_payload_schemas";

/**
 * The schemas decide whether a cached page is served, so each has to accept
 * what today's code writes and refuse what older code wrote. The drift guard
 * decides whether a schema still matches its type, so it has to be shown to
 * discriminate — a pass, a genuine fail, and the near-misses that a looser
 * check would wave through. The guard lives in the compiler, so its cases are
 * type-level: they are checked by `npm run typecheck`, not by running.
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

// --- The drift guard, shown to discriminate ----------------------------------
//
// The guard is a type, `TypeEquality`, and `SCHEMAS_MATCH_TYPES` in the source
// only compiles while every schema matches its type. Nothing here runs: a
// runtime assertion on a constant the compiler has already fixed cannot fail.
// Each line below instead stops `npm run typecheck` if the guard answers
// wrongly. A case that must be `true` is a plain annotation; a case that must
// be `false` is annotated `true` under `@ts-expect-error`, which itself fails
// the typecheck if the guard stops reporting the difference.

type Membership = { uri: string; inLibrary: boolean };
type FlatTrack = { uri: string; inLibrary: boolean; isrc: string | null };

// An intersection and a flat object with the same fields are equal — the case
// that made the first version of the guard fire on correct code.
export const intersectionEqualsFlatObject: TypeEquality<
  Membership & { isrc: string | null },
  FlatTrack
> = true;

// A missing field is a difference.
// @ts-expect-error the types differ, so the guard must not answer true
export const missingFieldIsADifference: TypeEquality<Membership, FlatTrack> = true;

// A field that became non-nullable is a difference.
// @ts-expect-error the types differ, so the guard must not answer true
export const changedNullabilityIsADifference: TypeEquality<
  Membership & { isrc: string },
  FlatTrack
> = true;

// The near-miss: `isrc?:` accepts an absent field, which is exactly the
// old-shape payload the schema exists to refuse.
// @ts-expect-error the types differ, so the guard must not answer true
export const optionalIsNotNullable: TypeEquality<
  Membership & { isrc?: string | null },
  FlatTrack
> = true;

// A difference nested inside an array is still a difference.
// @ts-expect-error the types differ, so the guard must not answer true
export const nestedDifferenceInArrayIsADifference: TypeEquality<
  { artists: { uri: string; name: string }[] },
  { artists: { uri: string }[] }
> = true;
