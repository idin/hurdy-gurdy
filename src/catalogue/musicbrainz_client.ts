/**
 * Reading MusicBrainz, which is where the permanent catalogue's identity
 * lives.
 *
 * Spotify identifies a *recording* — an ISRC separates Noel Harrison's
 * "Windmills of Your Mind" from Sting's, which is what stopped 68 keys from
 * over-merging. It offers nothing for the level above: that both are the same
 * *composition*, written by Legrand and the Bergmans. MusicBrainz models that
 * explicitly as a `work`, and `ISRC → recording → work` is the chain.
 *
 * ## Two things this client must respect
 *
 * **A descriptive User-Agent is mandatory.** MusicBrainz blocks anonymous
 * clients, and their documentation asks for an application name, a version
 * and a way to reach the maintainer.
 *
 * **One request per second, globally per IP.** Not per key, not per client —
 * per IP, shared with everything else on it. Exceeding it returns `503` on
 * *all* requests until the rate drops, so a burst does not merely fail
 * itself, it takes out everything alongside it. Observed on 2026-09-13:
 * three lookups at roughly 1.2-second spacing, two refused with "The
 * MusicBrainz web server is currently busy."
 *
 * This client therefore does not pace itself. Pacing belongs to the resolver
 * alarm, which already ticks at a controlled rate — a client that slept
 * internally would block a Worker invocation, which is billed by wall time.
 */

/** Base for every MusicBrainz web-service call. */
const MUSICBRAINZ_API_BASE = "https://musicbrainz.org/ws/2";

/**
 * Identifies this application to MusicBrainz.
 *
 * Required, and it must carry a real contact. An anonymous or generic
 * User-Agent is classed differently and blocked.
 */
export const MUSICBRAINZ_USER_AGENT = "hurdy-gurdy/1.0 ( idin@ixmachina.ai )";

/** Thrown when MusicBrainz refuses or is unavailable. */
export class MusicBrainzError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`MusicBrainz returned ${status}: ${body}`);
    this.name = "MusicBrainzError";
    this.status = status;
  }
}

/**
 * Whether a failure means "you are going too fast" rather than "that does not
 * exist".
 *
 * The distinction decides whether the resolver retries or gives up: a 503 is
 * transient and the task should come back, while a 404 means this ISRC is
 * genuinely unknown and retrying wastes the one request per second on a
 * question already answered.
 */
export function isMusicBrainzBusy(error: unknown): boolean {
  return error instanceof MusicBrainzError && error.status === 503;
}

/** A recording, as MusicBrainz identifies it. */
export type MusicBrainzRecording = {
  mbid: string;
  title: string;
  artistName: string | null;
  /**
   * The composition this recording is of, when MusicBrainz has the link.
   *
   * **Frequently absent, and that is data rather than failure.**
   * Recording-to-work is among the least complete relations in a
   * crowd-sourced database — Noel Harrison's Windmills recording has no work
   * relation while the work plainly exists. A null here means "MusicBrainz
   * does not say", never "there is no composition".
   */
  workMbid: string | null;
  workTitle: string | null;
};

/**
 * Look up the recording an ISRC identifies, and the work it is of.
 *
 * Two hops, because MusicBrainz's `isrc` resource does not accept the
 * inclusions that would return relations — verified 2026-09-13, where
 * `?inc=recordings+work-rels` was refused with "recordings is not a valid inc
 * parameter for the isrc resource". So: ISRC to recording, then recording to
 * work.
 *
 * Each hop is one request against the one-per-second budget, which is why
 * this is resolver work rather than something a tool call does inline.
 *
 * @param isrc - The recording's ISRC.
 * @param fetcher - Injected so tests do not reach the network.
 * @returns The recording, or null when MusicBrainz does not know this ISRC.
 */
export async function findRecordingByIsrc(
  isrc: string,
  fetcher: typeof fetch = fetch,
): Promise<MusicBrainzRecording | null> {
  const found = await requestJson<{ recordings?: { id: string; title: string }[] }>(
    `/isrc/${encodeURIComponent(isrc)}?fmt=json`,
    fetcher,
  );

  const recording = found.recordings?.[0];
  if (recording === undefined) {
    return null;
  }

  return findRecordingDetail(recording.id, fetcher);
}

/**
 * Fetch one recording's artist and work relation.
 *
 * Separate from the ISRC lookup so a caller that already has an MBID — from a
 * previous run, or from another source — does not spend a request rediscovering
 * it.
 *
 * @param mbid - The recording's MusicBrainz id.
 * @param fetcher - Injected for tests.
 */
export async function findRecordingDetail(
  mbid: string,
  fetcher: typeof fetch = fetch,
): Promise<MusicBrainzRecording> {
  const detail = await requestJson<{
    id: string;
    title: string;
    "artist-credit"?: { name: string }[];
    relations?: { work?: { id: string; title: string } }[];
  }>(`/recording/${encodeURIComponent(mbid)}?inc=work-rels+artist-credits&fmt=json`, fetcher);

  const work = (detail.relations ?? []).find((relation) => relation.work)?.work;

  return {
    mbid: detail.id,
    title: detail.title,
    artistName: detail["artist-credit"]?.[0]?.name ?? null,
    workMbid: work?.id ?? null,
    workTitle: work?.title ?? null,
  };
}

/**
 * Make one request, turning a refusal into a typed error.
 *
 * A 404 is returned as an empty result by the callers above rather than
 * thrown, because "MusicBrainz has never heard of this ISRC" is an answer.
 * A 503 throws, because it means the question was never asked.
 */
async function requestJson<Result>(path: string, fetcher: typeof fetch): Promise<Result> {
  const response = await fetcher(`${MUSICBRAINZ_API_BASE}${path}`, {
    headers: { "User-Agent": MUSICBRAINZ_USER_AGENT, Accept: "application/json" },
  });

  if (!response.ok) {
    throw new MusicBrainzError(response.status, await response.text());
  }

  return (await response.json()) as Result;
}

/**
 * How far a search result's length may differ and still be the same
 * recording.
 *
 * Masters of one recording differ by a second or two. Different recordings of
 * one song differ by far more — Motörhead's "Ace of Spades" returns matches at
 * 137s, 173s, 286s and 316s, **all scoring 100**, because the search scores
 * title and artist and knows nothing about which pressing is meant.
 *
 * Five seconds matches `SAME_SONG_DURATION_TOLERANCE_SECONDS` in the song
 * key, deliberately: the two answer the same question and disagreeing would
 * let a track match a recording its own key says is a different song.
 */
export const SEARCH_DURATION_TOLERANCE_MILLISECONDS = 5_000;

/**
 * The minimum search score worth considering at all.
 *
 * MusicBrainz scores 0-100 on title and artist similarity. Below this the
 * name matched loosely and the result is a different song that happens to
 * share words.
 */
export const MINIMUM_SEARCH_SCORE = 90;

/**
 * Find a recording by title, artist and length, when its ISRC is unknown.
 *
 * **A fallback, not a first choice.** An ISRC is the label's own assertion of
 * identity; this is a guess from three attributes. It exists because the ISRC
 * index is far less complete than the database — "Ace of Spades" has no ISRC
 * match at all, which is not obscure catalogue.
 *
 * Duration is what makes the guess safe. Without it the search returns
 * four equally-scored Motörhead recordings spanning three minutes of length,
 * and picking the top one would be picking arbitrarily. With it, only a
 * recording of the right length survives — which is the same rule the song
 * key already uses, so the two cannot disagree.
 *
 * Returns null rather than a best guess when nothing matches closely. A wrong
 * composition link is worse than none: it would group two unrelated songs and
 * do so invisibly, which is the failure that made ISRC replace title matching
 * in the first place.
 *
 * @param query.title - The recording's title.
 * @param query.artistName - The performing artist.
 * @param query.durationMs - Its length, which does the disambiguating.
 * @param fetcher - Injected for tests.
 * @returns The matching recording, or null when none is close enough.
 */
export async function searchRecording(
  query: { title: string; artistName: string; durationMs: number },
  fetcher: typeof fetch = fetch,
): Promise<MusicBrainzRecording | null> {
  const lucene = `recording:"${escapeLucene(query.title)}" AND artist:"${escapeLucene(query.artistName)}"`;
  const found = await requestJson<{
    recordings?: { id: string; title: string; score?: number; length?: number }[];
  }>(`/recording?query=${encodeURIComponent(lucene)}&limit=25&fmt=json`, fetcher);

  const candidate = (found.recordings ?? []).find(
    (recording) =>
      (recording.score ?? 0) >= MINIMUM_SEARCH_SCORE
      && recording.length != null
      && Math.abs(recording.length - query.durationMs) <= SEARCH_DURATION_TOLERANCE_MILLISECONDS,
  );

  return candidate === undefined ? null : findRecordingDetail(candidate.id, fetcher);
}

/**
 * Escape the characters Lucene treats as syntax.
 *
 * Track titles contain all of them. An unescaped quote or colon turns a
 * search into a malformed query, which MusicBrainz rejects rather than
 * ignoring.
 */
function escapeLucene(value: string): string {
  return value.replace(/(["\\+\-!(){}\[\]^~*?:/]|&&|\|\|)/g, "\\$1");
}
