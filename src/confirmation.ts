/**
 * Two-step confirmation for destructive operations.
 *
 * The first call to a destructive tool returns a token derived from the exact
 * operation requested, along with a description of what would happen. The
 * second call must echo that token back. A token therefore authorizes one
 * specific operation and nothing else — approving the removal of three tracks
 * from "R: Pink Floyd" cannot be replayed against "H8: Rammstein".
 *
 * This matters more here than in most places: Spotify's API has no undo. A
 * track removed from a playlist, or unsaved from a library, is gone, and the
 * agent calling these tools is working from a playlist id it may have matched
 * to the wrong name. The dry run puts the real name and the real track titles
 * in front of a human before anything is destroyed.
 *
 * Tokens are derived rather than stored, so no state is needed: no table to
 * migrate, nothing to clean up, and a restart cannot lose an in-flight
 * confirmation. They are salted with `COOKIE_ENCRYPTION_KEY` so a caller
 * cannot compute one offline, and bucketed by time so an unused token goes
 * stale instead of lasting forever.
 *
 * The design is `other-memory`'s `confirmation.ts`, which has been in
 * production since 2026-08 guarding memory deletes and reverts. Copied
 * deliberately rather than reinvented — a second, subtly different scheme
 * for the same problem is how one of them ends up with the weaker guarantee.
 */

/**
 * How long a token stays valid.
 *
 * Long enough that a human can read the dry run, think, and answer; short
 * enough that an abandoned confirmation cannot be replayed an hour later
 * against a playlist whose contents have since changed. Because the previous
 * bucket is also accepted, the effective lifetime is 10-20 minutes.
 */
const TOKEN_LIFETIME_MILLISECONDS = 10 * 60 * 1000;

/** How many bytes of the HMAC become the token. */
const TOKEN_BYTES = 8;

/** Bucket index for a moment in time. */
function findTimeBucket(now: number): number {
  return Math.floor(now / TOKEN_LIFETIME_MILLISECONDS);
}

/**
 * Derive the token for one operation in one time bucket.
 *
 * @param secret - Salt, so tokens cannot be computed by a caller.
 * @param operation - Canonical description of the exact operation.
 * @param bucket - Time bucket index.
 * @returns A short hex token.
 */
async function deriveToken(
  secret: string,
  operation: string,
  bucket: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${bucket}:${operation}`),
  );
  return [...new Uint8Array(signature)]
    .slice(0, TOKEN_BYTES)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build the canonical description of a destructive operation.
 *
 * Every input that changes what gets destroyed belongs in here, or a token
 * issued for one operation would authorize a different one. URIs are sorted
 * so that the same set in a different order yields the same token — the
 * operation is identical, and forcing the caller to preserve order would
 * fail confirmations for no reason.
 *
 * @param action - What is being done, e.g. `"remove_tracks_from_playlist"`.
 * @param target - What it is being done to: a playlist id, or `"library"`.
 * @param uris - The items affected.
 * @returns A stable string identifying exactly this operation.
 */
export function describeOperation(
  action: string,
  target: string,
  uris: string[],
): string {
  return `${action}:${target}:${[...uris].sort().join(",")}`;
}

/**
 * The token authorizing one operation right now.
 *
 * @param secret - Salt from the environment.
 * @param operation - From `describeOperation`.
 * @param now - Epoch milliseconds.
 * @returns The token the caller must echo back.
 */
export async function issueConfirmationToken(
  secret: string,
  operation: string,
  now: number,
): Promise<string> {
  return deriveToken(secret, operation, findTimeBucket(now));
}

/**
 * Whether a caller-supplied token authorizes this exact operation.
 *
 * The previous bucket is accepted as well, so a confirmation that arrives
 * just after a bucket boundary still works rather than failing for a reason
 * the caller cannot see or act on.
 *
 * @param secret - Salt from the environment.
 * @param operation - From `describeOperation`. Must match the first call's.
 * @param provided - The token the caller echoed back.
 * @param now - Epoch milliseconds.
 * @returns True when the token authorizes this operation.
 */
export async function isValidConfirmation(
  secret: string,
  operation: string,
  provided: string,
  now: number,
): Promise<boolean> {
  const bucket = findTimeBucket(now);
  const candidates = await Promise.all([
    deriveToken(secret, operation, bucket),
    deriveToken(secret, operation, bucket - 1),
  ]);
  return candidates.some((candidate) => isEqualInConstantTime(candidate, provided));
}

/**
 * Compare two strings without leaking their difference through timing.
 *
 * A token is a secret the caller is trying to produce, so an early return on
 * the first differing character would let one be guessed a character at a
 * time.
 */
function isEqualInConstantTime(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
