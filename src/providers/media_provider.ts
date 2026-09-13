/**
 * The contract every media provider implements.
 *
 * Tools call this interface, never a provider's own client directly — that is
 * what makes adding YouTube Music or Apple Music later a matter of writing a
 * new file under `providers/`, not touching every tool.
 *
 * Every list method is paginated and exhaustive by construction: none of them
 * return a capped top-N. The gap this whole package exists to close is a
 * connector whose search and library tools return at most five results with
 * no way to ask for more — every method here is shaped so that limitation
 * cannot recur.
 */

export type Track = {
  id: string;
  name: string;
  artistNames: string[];
  albumName: string;
  durationMs: number;
  uri: string;
};

export type Artist = {
  id: string;
  name: string;
  genres: string[];
  uri: string;
};

export type Album = {
  id: string;
  name: string;
  artistNames: string[];
  releaseDate: string;
  uri: string;
};

export type Playlist = {
  id: string;
  name: string;
  ownerName: string;
  /**
   * How many tracks the playlist holds, or `null` when the provider did not
   * say.
   *
   * Nullable rather than defaulted to `0`, because a count the provider
   * withheld is not a count of zero, and returning `0` would be inventing a
   * fact the caller would have no way to distinguish from a real empty
   * playlist. A caller needing the true count pages `getPlaylistTracks`.
   */
  trackCount: number | null;
  uri: string;
};

export type SearchResults = {
  tracks: Track[];
  artists: Artist[];
  albums: Album[];
  playlists: Playlist[];
};

/** What kinds of thing a search may be restricted to. */
export type SearchType = "track" | "artist" | "album" | "playlist";

/**
 * A single page of a paginated list, plus what is needed to fetch the next
 * one.
 *
 * `cursor` is provider-shaped on purpose — Spotify pages saved tracks by
 * numeric offset and followed artists by an artist-id cursor, and forcing
 * both into one shape would either lose information or invent a fake offset
 * for a cursor-based endpoint. Callers pass the cursor back unexamined.
 */
export type Page<Item> = {
  items: Item[];
  /** Present when more items exist; absent when this is the last page. */
  nextCursor: string | null;
  /** Total item count, when the provider reports one. */
  total: number | null;
};

export interface MediaProvider {
  /** The provider's own name, e.g. "spotify". Used to tag results and errors. */
  readonly name: string;

  /**
   * Search for content, across one or more types.
   *
   * @param query - Free-text query.
   * @param options.types - Which kinds to search. All four when omitted.
   * @param options.limit - Items per type, per page.
   * @param options.cursor - Page cursor from a previous call.
   */
  search(
    query: string,
    options?: { types?: SearchType[]; limit?: number; cursor?: string },
  ): Promise<{
    tracks: Page<Track>;
    artists: Page<Artist>;
    albums: Page<Album>;
    playlists: Page<Playlist>;
  }>;

  /** One page of the user's liked/saved tracks. */
  getLikedTracks(options?: { limit?: number; cursor?: string }): Promise<Page<Track>>;

  /** One page of the artists the user follows. */
  getFollowedArtists(options?: {
    limit?: number;
    cursor?: string;
  }): Promise<Page<Artist>>;

  /** One page of the user's saved albums. */
  getSavedAlbums(options?: { limit?: number; cursor?: string }): Promise<Page<Album>>;

  /** One page of the playlists the user owns or follows. */
  getPlaylists(options?: { limit?: number; cursor?: string }): Promise<Page<Playlist>>;

  /** Every track in one playlist, in order. */
  getPlaylistTracks(
    playlistId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<Page<Track>>;
}

/**
 * Fetch every page of a paginated call, following `nextCursor` until it is
 * null.
 *
 * The interface returns one page at a time because a Worker has a bounded
 * subrequest budget per invocation — see `other-memory`'s own
 * `FILES_INDEXED_PER_SEARCH` for the shape of that constraint recurring.
 * This helper is for callers who know the total is small enough (a personal
 * library, not an open-ended catalogue) to fetch in full within one call.
 *
 * @param fetchPage - Fetches one page, given the previous cursor or none.
 * @param options.maxPages - Hard ceiling, so a provider bug returning a
 *   cursor that never terminates cannot loop forever.
 * @returns Every item across every page.
 */
export async function fetchAllPages<Item>(
  fetchPage: (cursor: string | undefined) => Promise<Page<Item>>,
  options: { maxPages: number },
): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < options.maxPages; page += 1) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    if (result.nextCursor === null) {
      return items;
    }
    cursor = result.nextCursor;
  }
  throw new Error(
    `fetchAllPages did not terminate within ${options.maxPages} pages. `
      + "Either raise maxPages for a genuinely large list, or the provider's "
      + "cursor is not advancing.",
  );
}
