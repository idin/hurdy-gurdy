import { afterEach, describe, expect, test, vi } from "vitest";

import { SpotifyApiError, UNKNOWN_GRANTED_SCOPES } from "../../../src/providers/spotify/spotify_api_client";
import { SPOTIFY_SCOPES } from "../../../src/providers/spotify/spotify_oauth";
import { SpotifyProvider } from "../../../src/providers/spotify/spotify_provider";

/**
 * Regression for docs/bugs/resolved/2026-10-11_create_playlist_403_removed_users_endpoint.md.
 *
 * Spotify's February 2026 changelog marks `POST /users/{user_id}/playlists`
 * as removed ("Use `POST /me/playlists` instead"). This stands in for the
 * Spotify network edge only: it answers as the live API does today, refusing
 * the removed path with the 403 the user saw and accepting the replacement.
 * Everything above `fetch` (the provider and the client) is the real code.
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

    if (method === "POST" && path === "/me/playlists") {
      return new Response(
        JSON.stringify({
          id: "playlist-1",
          name: body.name,
          description: "",
          public: body.public ?? false,
          owner: { id: "idin", display_name: "Idin" },
          tracks: { total: 0 },
          uri: "spotify:playlist:playlist-1",
        }),
        { status: 201 },
      );
    }
    return new Response(JSON.stringify({ error: { status: 403, message: "Forbidden" } }), {
      status: 403,
    });
  }) as unknown as typeof fetch;
  return requests;
}

/** Makes the network edge answer the next request with a 403, as Spotify does for a refused write. */
function refuseNextWrite(): void {
  const answerRoutes = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    globalThis.fetch = answerRoutes;
    return new Response(JSON.stringify({ error: { status: 403, message: "Forbidden" } }), {
      status: 403,
    });
  }) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const PLAYLIST_NAME = "The Beautifully Macabre | Halloween After Dark";

describe("create_playlist against the current Spotify Web API", () => {
  test("creates a private playlist through POST /me/playlists, not the removed /users/{id}/playlists", async () => {
    const requests = installSpotifyNetwork();
    const provider = new SpotifyProvider("access-token");

    const created = await provider.createPlaylist({ name: PLAYLIST_NAME, isPublic: false });

    expect(created.name).toBe(PLAYLIST_NAME);
    const writes = requests.filter((request) => request.method === "POST");
    expect(writes.map((request) => request.path)).toEqual(["/me/playlists"]);
  });

  test("creates a playlist when public is omitted", async () => {
    installSpotifyNetwork();
    const provider = new SpotifyProvider("access-token");

    const created = await provider.createPlaylist({ name: PLAYLIST_NAME });

    expect(created.id).toBe("playlist-1");
  });
});

describe("a refused write names what was attempted", () => {
  test("the error carries the method, the path and the granted scopes", async () => {
    installSpotifyNetwork();
    // Refuse this write explicitly with a 403, so the test does not depend on
    // the fake's fallback answer for unlisted routes.
    refuseNextWrite();
    const provider = new SpotifyProvider("access-token", {
      grantedScopes: [...SPOTIFY_SCOPES],
    });

    const failure = await provider
      .updatePlaylistDetails("playlist-1", { name: "renamed" })
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(SpotifyApiError);
    const message = (failure as SpotifyApiError).message;
    expect(message).toContain("PUT");
    expect(message).toContain("/playlists/playlist-1");
    expect(message).toContain("playlist-modify-private");
    expect(message).toContain("playlist-modify-public");
  });

  test("says the scopes are unknown when none are known", async () => {
    installSpotifyNetwork();
    refuseNextWrite();
    const provider = new SpotifyProvider("access-token");

    const failure = await provider
      .updatePlaylistDetails("playlist-1", { name: "renamed" })
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(SpotifyApiError);
    expect((failure as SpotifyApiError).message).toContain(UNKNOWN_GRANTED_SCOPES);
  });
});
