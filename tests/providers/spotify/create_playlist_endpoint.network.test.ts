import { afterEach, describe, expect, test } from "vitest";

import { SpotifyApiError, UNKNOWN_GRANTED_SCOPES } from "../../../src/providers/spotify/spotify_api_client";
import { SPOTIFY_SCOPES } from "../../../src/providers/spotify/spotify_oauth";
import { SpotifyProvider } from "../../../src/providers/spotify/spotify_provider";
import { startLocalSpotifyServer, type LocalSpotifyServer, type Responder } from "./local_spotify_server";

/**
 * Regression for playbook/bugs/resolved/2026-10-11_create_playlist_403_removed_users_endpoint.md.
 *
 * Spotify's February 2026 changelog marks `POST /users/{user_id}/playlists`
 * as removed ("Use `POST /me/playlists` instead"). A real local HTTP server
 * answers as the live API does today, refusing the removed path with the 403
 * the user saw and accepting the replacement. Everything between the provider
 * and the socket is the real code.
 */

let server: LocalSpotifyServer | null = null;

async function startServer(respond: Responder): Promise<LocalSpotifyServer> {
  server = await startLocalSpotifyServer({ respond });
  return server;
}

afterEach(async () => {
  await server?.close();
  server = null;
});

const acceptOnlyTheReplacementEndpoint: Responder = (request) => {
  const body = request.body as { name: string; public?: boolean };
  if (request.method === "POST" && request.path === "/me/playlists") {
    return {
      status: 201,
      body: {
        id: "playlist-1",
        name: body.name,
        description: "",
        public: body.public ?? false,
        owner: { id: "idin", display_name: "Idin" },
        tracks: { total: 0 },
        uri: "spotify:playlist:playlist-1",
      },
    };
  }
  return { status: 403, body: {} };
};

/** Refuses every request with a 403, as Spotify does for a refused write. */
const refuseEveryWrite: Responder = () => ({ status: 403, body: {} });

function captureRenameFailure(provider: SpotifyProvider): Promise<unknown> {
  return provider
    .updatePlaylistDetails("playlist-1", { name: "renamed" })
    .then(() => null, (error: unknown) => error);
}

const PLAYLIST_NAME = "The Beautifully Macabre | Halloween After Dark";

describe("create_playlist against the current Spotify Web API", () => {
  test("creates a private playlist through POST /me/playlists, not the removed /users/{id}/playlists", async () => {
    const running = await startServer(acceptOnlyTheReplacementEndpoint);
    const provider = new SpotifyProvider("access-token", { apiBaseUrl: running.apiBaseUrl });

    const created = await provider.createPlaylist({ name: PLAYLIST_NAME, isPublic: false });

    expect(created.name).toBe(PLAYLIST_NAME);
    const writes = running.requests.filter((request) => request.method === "POST");
    expect(writes.map((request) => request.path)).toEqual(["/me/playlists"]);
  });

  test("creates a playlist when public is omitted", async () => {
    const running = await startServer(acceptOnlyTheReplacementEndpoint);
    const provider = new SpotifyProvider("access-token", { apiBaseUrl: running.apiBaseUrl });

    expect((await provider.createPlaylist({ name: PLAYLIST_NAME })).id).toBe("playlist-1");
  });
});

describe("a refused write names what was attempted", () => {
  test("the error carries the method, the path and the granted scopes", async () => {
    const running = await startServer(refuseEveryWrite);
    const provider = new SpotifyProvider("access-token", {
      apiBaseUrl: running.apiBaseUrl,
      grantedScopes: [...SPOTIFY_SCOPES],
    });

    const failure = await captureRenameFailure(provider);

    expect(failure).toBeInstanceOf(SpotifyApiError);
    const message = (failure as SpotifyApiError).message;
    expect(message).toContain("PUT");
    expect(message).toContain("/playlists/playlist-1");
    expect(message).toContain("playlist-modify-private");
    expect(message).toContain("playlist-modify-public");
  });

  test("says the scopes are unknown when none are known", async () => {
    const running = await startServer(refuseEveryWrite);
    const provider = new SpotifyProvider("access-token", { apiBaseUrl: running.apiBaseUrl });

    const failure = await captureRenameFailure(provider);

    expect(failure).toBeInstanceOf(SpotifyApiError);
    expect((failure as SpotifyApiError).message).toContain(UNKNOWN_GRANTED_SCOPES);
  });
});
