/**
 * Reading Spotify's data export into the shapes the cache stores.
 *
 * The export is what a data-portability request returns, and it answers
 * questions the Web API cannot. 2,263 liked tracks arrive in one file rather
 * than 46 paged calls whose combined output exceeds an agent's context; a
 * year of play events arrives with per-play `secondsPlayed`, which no endpoint
 * supplies at any price.
 *
 * **Every shape here was read off Idin's own export on 2026-09-13**, not
 * taken from documentation. That matters more than usual: the export's shapes
 * are not the API's, and three differences would each have produced silently
 * wrong data if assumed rather than checked.
 *
 * What the export does **not** carry:
 *
 * - **Durations.** So a track's `song_key` cannot be built from it, and the
 *   version-merging that key drives does not work on export-only rows.
 * - **Album track counts.** So `work_key` cannot be built either.
 * - **Artist URIs on tracks.** Only names — the exact trap that made an
 *   earlier version of the recording layer drop most artist links.
 * - **Any URI at all in the streaming history.** Plays are joined by artist
 *   and track name, which is fuzzy and sometimes wrong.
 *
 * So this seeds and enriches; the API still fills in identity and duration.
 * The two are complementary, and treating the export as a replacement would
 * quietly disable album works and version tools.
 */

/** A liked track, as `YourLibrary.json` carries it. */
export type ExportedTrack = {
  artist: string;
  album: string;
  track: string;
  /** `spotify:track:...` — the export does carry URIs here, unlike the plays. */
  uri: string;
};

/** A saved album. */
export type ExportedAlbum = {
  artist: string;
  album: string;
  uri: string;
};

/** A followed artist. */
export type ExportedArtist = {
  name: string;
  uri: string;
};

/** The shape of `YourLibrary.json`. */
export type ExportedLibrary = {
  tracks: ExportedTrack[];
  albums: ExportedAlbum[];
  artists: ExportedArtist[];
};

/** One track in a playlist, carrying the date it was added. */
export type ExportedPlaylistItem = {
  /** ISO date. **The API does not give this**, so it is export-only. */
  addedDate: string;
  trackUri: string;
  trackName: string;
  artistName: string;
  albumName: string;
};

/** A playlist with its full track listing. */
export type ExportedPlaylist = {
  name: string;
  lastModifiedDate: string;
  items: ExportedPlaylistItem[];
};

/**
 * One play event.
 *
 * No URI, deliberately reflecting the file: the streaming history identifies
 * tracks by name alone, so joining it to the catalogue is a name match and
 * inherently approximate.
 */
export type ExportedPlay = {
  /** `YYYY-MM-DD HH:MM`, in UTC. */
  endTime: string;
  artistName: string;
  trackName: string;
  /**
   * Named as the file names it, because `readExportedPlays` casts the parsed
   * JSON straight to this type — a renamed field here would read as undefined
   * with no error. The one place milliseconds survive; everything derived
   * from it is seconds.
   */
  msPlayed: number;
};

/**
 * Below this, a play is treated as a skip rather than a listen.
 *
 * Spotify's own threshold for counting a stream, and the convention the
 * export's consumers use. In Idin's history 41% of 15,599 plays fall under
 * it — which is the closest thing to a negative signal this project can get,
 * since a lazy catalogue has no true negatives.
 */
export const SKIP_THRESHOLD_SECONDS = 30;

/**
 * Divisor between the export file's unit and this codebase's.
 *
 * The file reports `msPlayed`; everything derived from it is seconds.
 */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * What the plays say about one track.
 *
 * Keyed by artist and track name because that is all the file provides.
 */
export type PlaySummary = {
  artistName: string;
  trackName: string;
  /** Plays that ran past the skip threshold. */
  playCount: number;
  /** Plays abandoned before it. */
  skipCount: number;
  totalSecondsPlayed: number;
  /** `YYYY-MM-DD HH:MM` of the most recent play. */
  lastPlayed: string;
};

/**
 * Parse `YourLibrary.json`.
 *
 * @param raw - The file's contents.
 * @returns Liked tracks, saved albums and followed artists.
 */
export function readExportedLibrary(raw: string): ExportedLibrary {
  const parsed = JSON.parse(raw) as Partial<ExportedLibrary>;
  return {
    tracks: parsed.tracks ?? [],
    albums: parsed.albums ?? [],
    artists: parsed.artists ?? [],
  };
}

/**
 * Parse `Playlist1.json`.
 *
 * The file nests each item as `{ addedDate, track: { trackUri, ... } }`,
 * which is flattened here so callers do not have to know that shape.
 *
 * @param raw - The file's contents.
 * @returns Playlists with their track listings.
 */
export function readExportedPlaylists(raw: string): ExportedPlaylist[] {
  const parsed = JSON.parse(raw) as {
    playlists?: {
      name: string;
      lastModifiedDate: string;
      items?: {
        addedDate: string;
        track?: {
          trackUri: string;
          trackName: string;
          artistName: string;
          albumName: string;
        } | null;
      }[];
    }[];
  };

  return (parsed.playlists ?? []).map((playlist) => ({
    name: playlist.name,
    lastModifiedDate: playlist.lastModifiedDate,
    items: (playlist.items ?? [])
      // A local file added through the desktop client has no track object.
      // Dropping it is correct — it has no URI to store — but it must not
      // throw, because one such entry would abandon the whole playlist.
      .filter((item) => item.track != null && item.track.trackUri != null)
      .map((item) => ({
        addedDate: item.addedDate,
        trackUri: item.track!.trackUri,
        trackName: item.track!.trackName,
        artistName: item.track!.artistName,
        albumName: item.track!.albumName,
      })),
  }));
}

/**
 * Parse one `StreamingHistory_music_*.json`.
 *
 * @param raw - The file's contents.
 * @returns Play events, in the file's own order.
 */
export function readExportedPlays(raw: string): ExportedPlay[] {
  return JSON.parse(raw) as ExportedPlay[];
}

/**
 * Reduce raw play events to per-track counts.
 *
 * Separating plays from skips rather than counting both: a track abandoned
 * after four seconds is evidence *against* liking it, and summing the two
 * would make a heavily-skipped track look popular.
 *
 * @param plays - Every play event, from every history file.
 * @returns One summary per distinct track, keyed `artist\u241ftrack`.
 */
export function summarisePlays(plays: ExportedPlay[]): Map<string, PlaySummary> {
  const summaries = new Map<string, PlaySummary>();

  for (const play of plays) {
    const key = buildPlayKey(play.artistName, play.trackName);
    const existing = summaries.get(key);
    const secondsPlayed = play.msPlayed / MILLISECONDS_PER_SECOND;
    const isSkip = secondsPlayed < SKIP_THRESHOLD_SECONDS;

    if (existing === undefined) {
      summaries.set(key, {
        artistName: play.artistName,
        trackName: play.trackName,
        playCount: isSkip ? 0 : 1,
        skipCount: isSkip ? 1 : 0,
        totalSecondsPlayed: secondsPlayed,
        lastPlayed: play.endTime,
      });
      continue;
    }

    existing.playCount += isSkip ? 0 : 1;
    existing.skipCount += isSkip ? 1 : 0;
    existing.totalSecondsPlayed += secondsPlayed;
    if (play.endTime > existing.lastPlayed) {
      existing.lastPlayed = play.endTime;
    }
  }

  return summaries;
}

/**
 * The key a play is matched on.
 *
 * A unit-separator character (U+241F, the *printable* symbol for it) rather
 * than a NUL: track and artist names contain every printable character, so a
 * pipe can be forged by the data — `a|b` by `c` versus `a` by `b|c` — but an
 * actual NUL cannot travel through SQL text at all.
 *
 * That is not theoretical. The first version used `\0`, and every generated
 * INSERT carried a raw NUL inside a string literal; SQLite rejected all 6,517
 * of them with `unrecognized token`, pointing at the apostrophe after the NUL
 * rather than at the NUL itself.
 *
 * @param artistName - As the play event spells it.
 * @param trackName - As the play event spells it.
 * @returns A key for joining plays to tracks.
 */
export function buildPlayKey(artistName: string, trackName: string): string {
  return `${artistName.trim().toLowerCase()}\u241f${trackName.trim().toLowerCase()}`;
}
