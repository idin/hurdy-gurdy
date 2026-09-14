/**
 * Resolving MusicBrainz identity through ListenBrainz.
 *
 * Same organisation, same data, vastly different throughput. MusicBrainz's
 * web service documents one request per second and in practice refuses
 * sustained traffic at any spacing tried — 1.1s, 2s and 4s all produced 503s
 * on most requests, measured 2026-09-13. ListenBrainz allows **30 requests
 * per rolling nine seconds** and served ten back-to-back lookups with none
 * refused.
 *
 * For a 2,282-track library that is roughly twelve minutes against thirteen
 * hours. It is the difference between a feature and a plan.
 *
 * Their `metadata/lookup` endpoint is purpose-built for this: artist name
 * plus recording name in, a MusicBrainz recording id out. It is what
 * ListenBrainz uses to map incoming listens onto the catalogue, so it is
 * tuned for exactly the messy, mis-spelled, differently-punctuated names a
 * real library contains.
 *
 * **It takes names, not an ISRC.** That is a strength here rather than a
 * limitation: the ISRC index is the incomplete part of MusicBrainz — *Ace of
 * Spades* has no ISRC entry at all — while names are what the mapper is
 * built to handle.
 */

const LISTENBRAINZ_API_BASE = "https://api.listenbrainz.org/1";

/**
 * Requests allowed per window, from their own `X-RateLimit-Limit` header.
 *
 * Read off a live response rather than documentation: 30 per window, with
 * `X-RateLimit-Reset-In` reporting about nine seconds.
 */
export const LISTENBRAINZ_REQUESTS_PER_WINDOW = 30;

/** Thrown when ListenBrainz refuses. */
export class ListenBrainzError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`ListenBrainz returned ${status}: ${body}`);
    this.name = "ListenBrainzError";
    this.status = status;
  }
}

/** Whether a failure means the rate limit was hit rather than the lookup failing. */
export function isListenBrainzRateLimited(error: unknown): boolean {
  return error instanceof ListenBrainzError && error.status === 429;
}

/** What the mapper found for one artist-and-title pair. */
export type MappedRecording = {
  recordingMbid: string;
  recordingName: string;
  artistCreditName: string;
  artistMbids: string[];
  releaseMbid: string | null;
  releaseName: string | null;
};

/**
 * Map an artist and recording name onto a MusicBrainz recording.
 *
 * Returns null when the mapper cannot place it — an empty object rather than
 * an error, which is how ListenBrainz signals no match. Null is the honest
 * answer: it means nothing in MusicBrainz matched these names, not that the
 * recording does not exist.
 *
 * @param query.artistName - As the provider spells it.
 * @param query.recordingName - The track title.
 * @param token - A ListenBrainz user token.
 * @param fetcher - Injected so tests do not reach the network.
 */
export async function mapRecording(
  query: { artistName: string; recordingName: string },
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<MappedRecording | null> {
  const url =
    `${LISTENBRAINZ_API_BASE}/metadata/lookup/`
    + `?artist_name=${encodeURIComponent(query.artistName)}`
    + `&recording_name=${encodeURIComponent(query.recordingName)}`;

  const response = await fetcher(url, {
    headers: { Authorization: `Token ${token}` },
  });

  if (!response.ok) {
    throw new ListenBrainzError(response.status, await response.text());
  }

  const body = (await response.json()) as {
    recording_mbid?: string;
    recording_name?: string;
    artist_credit_name?: string;
    artist_mbids?: string[];
    release_mbid?: string;
    release_name?: string;
  };

  // No match comes back as a body with no recording_mbid, not as an error.
  if (body.recording_mbid === undefined) {
    return null;
  }

  return {
    recordingMbid: body.recording_mbid,
    recordingName: body.recording_name ?? query.recordingName,
    artistCreditName: body.artist_credit_name ?? query.artistName,
    artistMbids: body.artist_mbids ?? [],
    releaseMbid: body.release_mbid ?? null,
    releaseName: body.release_name ?? null,
  };
}

/**
 * How long to wait before the next request, from a response's own headers.
 *
 * Reading their counter rather than guessing a rate: the window is rolling
 * and the headers say exactly how many requests remain and when it resets, so
 * a client that reads them cannot drift out of step the way a fixed sleep
 * does.
 *
 * @param headers - From any ListenBrainz response.
 * @returns Milliseconds to wait. Zero while budget remains.
 */
export function findRateLimitDelay(headers: Headers): number {
  const remaining = Number(headers.get("x-ratelimit-remaining") ?? "1");
  const resetIn = Number(headers.get("x-ratelimit-reset-in") ?? "0");

  // One spare request is kept in hand, so a concurrent caller — the resolver
  // alarm, say — does not push the count past zero between our check and our
  // next call.
  return remaining > 1 ? 0 : Math.max(0, resetIn * 1000) + RESET_MARGIN_MS;
}

/** Added to a reported reset, since the window boundary is not exact. */
const RESET_MARGIN_MS = 500;
