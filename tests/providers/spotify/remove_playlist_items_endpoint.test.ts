import { afterEach, describe, expect, test, vi } from "vitest";

import { SpotifyProvider } from "../../../src/providers/spotify/spotify_provider";

/**
 * Spotify's remove-items reference
 * (https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist)
 * takes `DELETE /playlists/{id}/items` with a body of `{"items":[{"uri":...}]}`.
 * The old `/tracks` endpoint took `tracks`; sending that field to `/items` is refused.
 *
 * This stands in for the Spotify network edge only: it accepts the request
 * only when the body uses `items`, and records what was sent. Everything above
 * `fetch` (the provider and the client) is the real code.
 */
type RecordedRequest = { method: string; path: string; body: unknown };

function installSpotifyNetwork(): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v1/, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, body });

    if (method === "DELETE" && /^\/playlists\/[^/]+\/items$/.test(path)) {
      if (Array.isArray(body?.items)) {
        return new Response(JSON.stringify({ snapshot_id: "snapshot-2" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ error: { status: 400, message: "Missing required field: items" } }),
        { status: 400 },
      );
    }
    return new Response("{}", { status: 403 });
  }) as unknown as typeof fetch;
  return requests;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TRACK_URIS = ["spotify:track:4iV5W9uYEdYUVa79Axb7Rh", "spotify:track:1301WleyT98MSxVHPZCA6M"];

describe("removing tracks from a playlist against the current Spotify Web API", () => {
  test("sends DELETE /playlists/{id}/items with the uris under `items`, not `tracks`", async () => {
    const requests = installSpotifyNetwork();
    const provider = new SpotifyProvider("access-token");

    await provider.removeTracksFromPlaylist("playlist-1", TRACK_URIS);

    const deletes = requests.filter((request) => request.method === "DELETE");
    expect(deletes).toEqual([
      {
        method: "DELETE",
        path: "/playlists/playlist-1/items",
        body: { items: TRACK_URIS.map((uri) => ({ uri })) },
      },
    ]);
  });
});
