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

/**
 * Every result type carries `uri` and `inLibrary`, in every tool that
 * returns it.
 *
 * Uniformity is the point. A shape that gains a field in one tool and loses
 * it in another forces the caller to know which tool produced a result before
 * it can read it — and two results of the same kind stop being comparable or
 * mergeable. So `inLibrary` is present even where it is knowable in advance:
 * in a library listing it is `true` for every item by construction, which is
 * redundant and costs nothing, and is far cheaper than a caller having to ask
 * which shape it is holding.
 *
 * Fields still differ *between* types — an artist has no album — because
 * forcing one shape across all four would mean nulls that never carry
 * information.
 */
type LibraryMembership = {
  /** Spotify URI, the identifier every write tool accepts. */
  uri: string;
  /**
   * Whether this exact thing is saved to, or followed in, the library.
   *
   * For a track, saved. For an album, saved. For an artist, followed. For a
   * playlist, followed or owned. Always `true` in library listings, where it
   * holds by construction; resolved against the provider for search results,
   * which mix both.
   *
   * Note this is **not** the same question as whether the library contains
   * *anything by* an artist or *from* an album — 75 artists are followed
   * while liked tracks span many hundreds more. That is `hasAnyLiked`.
   */
  inLibrary: boolean;
};

/**
 * How much of a thing the library actually holds.
 *
 * A boolean is the wrong instrument here. "Do I have this album?" has a more
 * useful answer than yes or no: *three of its twelve tracks*. Coverage says
 * that; membership cannot.
 *
 * Numerators come from the cached liked tracks and are cheap. Denominators
 * are not: Spotify publishes no total-tracks figure for an artist, so it
 * means fetching every release and counting, which is roughly eleven requests
 * for a band with ten albums — far past what a search can spend inside a
 * Worker's fifty-subrequest budget.
 *
 * So a denominator is `null` until the background resolver has crawled that
 * artist, and permanent once known. The numerator and `hasAnyLiked` are
 * available immediately. A caller renders "3 liked" now and "3 / 12" later,
 * rather than waiting on a crawl before showing anything.
 */
type LibraryCoverage = {
  /** Liked tracks by or from this, counted from the cache. */
  likedTrackCount: number;
  /** Total tracks, or `null` until the resolver has counted them. */
  totalTrackCount: number | null;
  /**
   * True when at least one track is liked — `likedTrackCount > 0`.
   *
   * Carried explicitly rather than left for the caller to derive, so the
   * common question is answerable without arithmetic and without knowing
   * whether a null denominator makes the ratio unreadable.
   */
  hasAnyLiked: boolean;
};

export type Track = LibraryMembership & {
  id: string;
  name: string;
  artistNames: string[];
  albumName: string | null;
  durationMs: number;
};

export type Artist = LibraryMembership &
  LibraryCoverage & {
    id: string;
    name: string;
    genres: string[];
    /**
     * Albums with at least one liked track, over the artist's album count.
     *
     * A second coverage axis, because breadth and depth differ: forty liked
     * tracks from one album is a different relationship to an artist than
     * one track from each of forty albums, and `likedTrackCount` alone
     * cannot tell them apart.
     *
     * Counts the artist's own albums and singles, excluding releases they
     * merely appear on — a compilation of other artists' work would inflate
     * the denominator with records that are not theirs.
     */
    albumsWithLikedTracks: number;
    /** The artist's albums and singles, or `null` until the resolver counts them. */
    totalAlbumCount: number | null;
  };

/**
 * An album.
 *
 * Unlike an artist, an album's `totalTrackCount` costs nothing — Spotify
 * carries it on the album object itself — so it is populated immediately and
 * is only null when the provider withheld it. The resolver never needs to
 * crawl for it.
 */
export type Album = LibraryMembership &
  LibraryCoverage & {
    id: string;
    name: string;
    artistNames: string[];
    releaseDate: string | null;
  };

export type Playlist = LibraryMembership & {
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

  // --- Writes -------------------------------------------------------------
  //
  // Optional on the interface, not required. A provider that can only read —
  // a local-folder reader, say — implements none of these, and the tool layer
  // reports the capability as absent rather than a provider having to throw
  // from a method it was forced to declare.

  /** Add items to a playlist. */
  addTracksToPlaylist?(
    playlistId: string,
    uris: string[],
    options?: { position?: number },
  ): Promise<void>;

  /** Remove items from a playlist. Irreversible. */
  removeTracksFromPlaylist?(playlistId: string, uris: string[]): Promise<void>;

  /** Create a playlist, returning the created one. */
  createPlaylist?(details: {
    name: string;
    description?: string;
    isPublic?: boolean;
  }): Promise<Playlist>;

  /** Rename a playlist or change its description or visibility. */
  updatePlaylistDetails?(
    playlistId: string,
    details: { name?: string; description?: string; isPublic?: boolean },
  ): Promise<void>;

  /** Save items to the library. */
  saveToLibrary?(uris: string[]): Promise<void>;

  /** Remove items from the library. Irreversible. */
  removeFromLibrary?(uris: string[]): Promise<void>;

  // --- Playback -----------------------------------------------------------

  /** What is playing right now, or null when nothing is. */
  getCurrentlyPlaying?(): Promise<NowPlaying | null>;

  /** Every device playback can be sent to. */
  listDevices?(): Promise<Device[]>;

  /**
   * Start or resume playback.
   *
   * @param uri - What to play. A track, album, artist or playlist URI; the
   *   provider decides how each is sent. Absent resumes what is loaded.
   */
  play?(options?: {
    uri?: string;
    deviceId?: string;
    /**
     * A device named the way a person would name it — "phone", "kitchen",
     * "TV". Resolved against both the device's name and its type. When it
     * matches nothing the call fails rather than playing somewhere else.
     */
    deviceName?: string;
  }): Promise<void>;

  /** Pause playback. */
  pause?(options?: { deviceId?: string }): Promise<void>;

  /** Skip to the next track. */
  skipToNext?(options?: { deviceId?: string }): Promise<void>;

  /** Skip to the previous track. */
  skipToPrevious?(options?: { deviceId?: string }): Promise<void>;

  /** Move playback to another device. */
  transferPlayback?(deviceId: string, options?: { play?: boolean }): Promise<void>;
}

/** A device playback can be sent to. */
export type Device = {
  id: string | null;
  name: string;
  /** e.g. "Computer", "Smartphone", "Speaker". */
  type: string;
  isActive: boolean;
  /** True when the device cannot accept Web API playback commands. */
  isRestricted: boolean;
  volumePercent: number | null;
};

/** What is playing right now. */
export type NowPlaying = {
  isPlaying: boolean;
  track: Track | null;
  progressMs: number | null;
  deviceName: string | null;
};

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
