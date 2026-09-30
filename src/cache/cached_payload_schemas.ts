/**
 * What a cached page must look like to be served.
 *
 * The response cache stores provider pages as JSON under a 66-day *sliding*
 * expiry, so a page that keeps being read never expires — it outlives any
 * change to the types it was written with. Trusting it to match today's types
 * is how liked tracks broke on 2026-09-30: pages cached before `isrc`
 * (2026-09-13) and `durationSeconds` (2026-09-18) existed parsed with those
 * fields `undefined`, and D1 refused to bind them. See
 * `docs/bugs/resolved/2026-09-30_liked_tracks_fail_on_a_page_cached_by_older_code.md`.
 *
 * So a cached payload is checked against its schema on every read, and one
 * that does not match is a miss: refetched and replaced, never repaired. A
 * repair would have to know every shape that was ever written; a refetch only
 * has to know the current one.
 *
 * **The schemas cannot drift from the types.** Each is checked against the
 * type it guards at compile time, below, so changing `Track` without changing
 * `TRACK_SCHEMA` fails `npm run typecheck` instead of failing in production
 * weeks later.
 */

import { z } from "zod";

import type { Album, Artist, Page, Playlist, Track } from "../providers/media_provider";

/** Shared by every item: which object it is, and whether it is in the library. */
const LIBRARY_MEMBERSHIP_SHAPE = {
  uri: z.string(),
  inLibrary: z.boolean(),
};

/** Shared by artists and albums: how much of each the library holds. */
const LIBRARY_COVERAGE_SHAPE = {
  likedTrackCount: z.number(),
  totalTrackCount: z.number().nullable(),
  hasAnyLiked: z.boolean(),
};

export const TRACK_SCHEMA = z.object({
  ...LIBRARY_MEMBERSHIP_SHAPE,
  id: z.string(),
  name: z.string(),
  artists: z.array(z.object({ uri: z.string(), name: z.string() })),
  artistNames: z.array(z.string()),
  albumName: z.string().nullable(),
  albumUri: z.string().nullable(),
  albumTrackCount: z.number().nullable(),
  durationSeconds: z.number(),
  isrc: z.string().nullable(),
});

export const ARTIST_SCHEMA = z.object({
  ...LIBRARY_MEMBERSHIP_SHAPE,
  ...LIBRARY_COVERAGE_SHAPE,
  id: z.string(),
  name: z.string(),
  genres: z.array(z.string()),
  albumsWithLikedTracks: z.number(),
  totalAlbumCount: z.number().nullable(),
});

export const ALBUM_SCHEMA = z.object({
  ...LIBRARY_MEMBERSHIP_SHAPE,
  ...LIBRARY_COVERAGE_SHAPE,
  id: z.string(),
  name: z.string(),
  artistNames: z.array(z.string()),
  releaseDate: z.string().nullable(),
});

export const PLAYLIST_SCHEMA = z.object({
  ...LIBRARY_MEMBERSHIP_SHAPE,
  id: z.string(),
  name: z.string(),
  ownerName: z.string(),
  trackCount: z.number().nullable(),
});

/**
 * The schema of a page of items.
 *
 * @param itemSchema - What each item must look like.
 * @returns A schema for a `Page` of those items.
 */
function buildPageSchema<ItemSchema extends z.ZodType>(itemSchema: ItemSchema) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
    total: z.number().nullable(),
  });
}

export const TRACK_PAGE_SCHEMA = buildPageSchema(TRACK_SCHEMA);
export const ARTIST_PAGE_SCHEMA = buildPageSchema(ARTIST_SCHEMA);
export const ALBUM_PAGE_SCHEMA = buildPageSchema(ALBUM_SCHEMA);
export const PLAYLIST_PAGE_SCHEMA = buildPageSchema(PLAYLIST_SCHEMA);

// --- Drift guard -------------------------------------------------------------
//
// True only when the two types are identical in both directions — a field
// added, removed, renamed or made nullable on either side makes it false, and
// assigning `true` to `false` is a compile error. The standard exact-equality
// check: plain mutual `extends` would let an optional field pass as required.
//
// Both sides are flattened first, deeply. The provider types are written as
// intersections (`LibraryMembership & { ... }`) and zod infers one flat
// object; the exact check tells those apart even when every field agrees,
// which would make the guard fire on correct code.

type FlattenType<Value> = Value extends (infer Element)[]
  ? FlattenType<Element>[]
  : Value extends object
    ? { [Key in keyof Value]: FlattenType<Value[Key]> }
    : Value;

export type CheckTypesEqual<Left, Right> =
  (<Probe>() => Probe extends FlattenType<Left> ? 1 : 2) extends <
    Probe,
  >() => Probe extends FlattenType<Right> ? 1 : 2
    ? true
    : false;

export const SCHEMAS_MATCH_TYPES: {
  track: CheckTypesEqual<z.infer<typeof TRACK_SCHEMA>, Track>;
  artist: CheckTypesEqual<z.infer<typeof ARTIST_SCHEMA>, Artist>;
  album: CheckTypesEqual<z.infer<typeof ALBUM_SCHEMA>, Album>;
  playlist: CheckTypesEqual<z.infer<typeof PLAYLIST_SCHEMA>, Playlist>;
  trackPage: CheckTypesEqual<z.infer<typeof TRACK_PAGE_SCHEMA>, Page<Track>>;
} = { track: true, artist: true, album: true, playlist: true, trackPage: true };
