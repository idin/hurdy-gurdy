import { afterEach, describe, expect, test } from "vitest";

import { SpotifyProvider } from "../../../src/providers/spotify/spotify_provider";
import { startLocalSpotifyServer, type LocalSpotifyServer } from "./local_spotify_server";

/**
 * Spotify's remove-items reference
 * (https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist)
 * takes `DELETE /playlists/{id}/items` with a body of `{"items":[{"uri":...}]}`.
 * The old `/tracks` endpoint took `tracks`; sending that field to `/items` is refused.
 *
 * A real local HTTP server accepts the request only when the body uses
 * `items`, and records what was sent. Everything between the provider and the
 * socket is the real code.
 */

let server: LocalSpotifyServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const TRACK_URIS = ["spotify:track:4iV5W9uYEdYUVa79Axb7Rh", "spotify:track:1301WleyT98MSxVHPZCA6M"];

describe("removing tracks from a playlist against the current Spotify Web API", () => {
  test("sends DELETE /playlists/{id}/items with the uris under `items`, not `tracks`", async () => {
    server = await startLocalSpotifyServer({
      respond: (request) => {
        const body = request.body as { items?: unknown } | undefined;
        if (request.method === "DELETE" && /^\/playlists\/[^/]+\/items$/.test(request.path)) {
          return Array.isArray(body?.items)
            ? { status: 200, body: { snapshot_id: "snapshot-2" } }
            : { status: 400, body: { error: { status: 400, message: "Missing required field: items" } } };
        }
        return { status: 403, body: {} };
      },
    });
    const provider = new SpotifyProvider("access-token", { apiBaseUrl: server.apiBaseUrl });

    await provider.removeTracksFromPlaylist("playlist-1", TRACK_URIS);

    const deletes = server.requests.filter((request) => request.method === "DELETE");
    expect(deletes.map((request) => ({ method: request.method, path: request.path, body: request.body }))).toEqual([
      {
        method: "DELETE",
        path: "/playlists/playlist-1/items",
        body: { items: TRACK_URIS.map((uri) => ({ uri })) },
      },
    ]);
  });
});
