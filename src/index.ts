import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { version as PACKAGE_VERSION } from "../package.json";

import {
  describeOperation,
  issueConfirmationToken,
  isValidConfirmation,
} from "./confirmation";
import { SpotifyProvider } from "./providers/spotify/spotify_provider";
import {
  LIBRARY_WRITE_MAX_ITEMS,
  PLAYLIST_ADD_MAX_ITEMS,
} from "./providers/spotify/spotify_api_client";
import { getAccessToken } from "./providers/spotify/spotify_session";
import type { MediaProvider, SearchType } from "./providers/media_provider";
import {
  buildFailure,
  consoleFailureSink,
  reportingFailures,
  type FailureSink,
} from "./tool_errors";
import type { Env, UserProps } from "./types";

const SEARCH_TYPES = ["track", "artist", "album", "playlist"] as const satisfies readonly SearchType[];

/**
 * Every list tool shares the same two paging parameters, so the shape is
 * declared once here rather than repeated per tool with a chance to drift.
 */
const PAGING_SCHEMA = {
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Items per page. Provider's own maximum applies if higher."),
  cursor: z
    .string()
    .optional()
    .describe("Cursor from a previous call's response, to fetch the next page."),
};

export class HurdyGurdyMCP extends McpAgent<Env, unknown, UserProps> {
  server = new McpServer({
    name: "hurdy-gurdy",
    title: "Hurdy-Gurdy",
    version: PACKAGE_VERSION,
  });

  protected failureSink: FailureSink = consoleFailureSink;

  private async provider(): Promise<SpotifyProvider> {
    if (!this.props?.spotifyUserId) {
      throw new Error("Not authenticated with Spotify.");
    }
    const accessToken = await getAccessToken(this.env.SPOTIFY_TOKENS, this.props.spotifyUserId, {
      clientId: this.env.SPOTIFY_CLIENT_ID,
      now: () => Date.now(),
    });
    return new SpotifyProvider(accessToken);
  }

  /**
   * Register a tool whose failures are recorded rather than thrown.
   *
   * Same reasoning as `other-memory`'s equivalent wrapper: a tool
   * registered the direct SDK way would still work, and would lose its
   * failures silently — invisible until the day someone needed the log.
   */
  protected registerTool<InputSchema extends z.ZodRawShape>(
    name: string,
    definition: { description: string; inputSchema: InputSchema },
    handler: (args: { [Key in keyof InputSchema]: z.infer<InputSchema[Key]> }) => Promise<unknown>,
  ): void {
    type Arguments = { [Key in keyof InputSchema]: z.infer<InputSchema[Key]> };
    this.server.registerTool(
      name,
      definition as Parameters<McpServer["registerTool"]>[1],
      (async (args: Arguments) =>
        reportingFailures({
          tool: name,
          args,
          spotifyUserId: this.props?.spotifyUserId ?? null,
          sink: this.failureSink,
          run: async () => handler(args),
        })) as unknown as Parameters<McpServer["registerTool"]>[2],
    );
  }

  async init() {
    this.registerSearchTool();
    this.registerLikedTracksTool();
    this.registerFollowedArtistsTool();
    this.registerSavedAlbumsTool();
    this.registerPlaylistsTool();
    this.registerPlaylistTracksTool();
    this.registerPlaylistWriteTools();
    this.registerLibraryWriteTools();
    this.registerPlaybackTools();
  }

  private registerSearchTool() {
    this.registerTool(
      "search_media",
      {
        description:
          "Search Spotify for tracks, artists, albums and playlists. Unlike " +
          "the built-in Spotify connector's search (capped at 5 results " +
          "total, one page, no way to ask for more), this returns up to 10 " +
          "results per type per call and accepts a cursor to page further. " +
          "Supports Spotify's field filters in the query, e.g. " +
          '`artist:Radiohead track:Karma Police` or `year:2020`.',
        inputSchema: {
          query: z.string().describe("Free-text query, optionally using Spotify field filters."),
          types: z
            .array(z.enum(SEARCH_TYPES))
            .optional()
            .describe("Which kinds to search. All four when omitted."),
          ...PAGING_SCHEMA,
        },
      },
      async ({ query, types, limit, cursor }) => {
        const provider = await this.provider();
        const result = await provider.search(query, { types, limit, cursor });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
  }

  private registerLikedTracksTool() {
    this.registerTool(
      "get_liked_tracks",
      {
        description:
          "List the user's liked (saved) tracks on Spotify, one page at a " +
          "time. Unlike the built-in connector, which has no tool for this " +
          "at all — only a 5-result search — this pages through the full " +
          "library via the real Spotify API. Pass the returned cursor back " +
          "to fetch the next page; a null cursor means this was the last page.",
        inputSchema: PAGING_SCHEMA,
      },
      async ({ limit, cursor }) => {
        const provider = await this.provider();
        const page = await provider.getLikedTracks({ limit, cursor });
        return { content: [{ type: "text" as const, text: JSON.stringify(page, null, 2) }] };
      },
    );
  }

  private registerFollowedArtistsTool() {
    this.registerTool(
      "get_followed_artists",
      {
        description:
          "List every artist the user follows on Spotify, one page at a " +
          "time — this is what answers \"what bands do I like\" completely, " +
          "which the built-in connector's 5-result search cannot. Pass the " +
          "returned cursor back to fetch the next page.",
        inputSchema: PAGING_SCHEMA,
      },
      async ({ limit, cursor }) => {
        const provider = await this.provider();
        const page = await provider.getFollowedArtists({ limit, cursor });
        return { content: [{ type: "text" as const, text: JSON.stringify(page, null, 2) }] };
      },
    );
  }

  private registerSavedAlbumsTool() {
    this.registerTool(
      "get_saved_albums",
      {
        description:
          "List the user's saved albums on Spotify, one page at a time.",
        inputSchema: PAGING_SCHEMA,
      },
      async ({ limit, cursor }) => {
        const provider = await this.provider();
        const page = await provider.getSavedAlbums({ limit, cursor });
        return { content: [{ type: "text" as const, text: JSON.stringify(page, null, 2) }] };
      },
    );
  }

  private registerPlaylistsTool() {
    this.registerTool(
      "get_playlists",
      {
        description:
          "List the playlists the user owns or follows on Spotify, one " +
          "page at a time.",
        inputSchema: PAGING_SCHEMA,
      },
      async ({ limit, cursor }) => {
        const provider = await this.provider();
        const page = await provider.getPlaylists({ limit, cursor });
        return { content: [{ type: "text" as const, text: JSON.stringify(page, null, 2) }] };
      },
    );
  }

  private registerPlaylistTracksTool() {
    this.registerTool(
      "get_playlist_tracks",
      {
        description:
          "List every track in one Spotify playlist, one page at a time. " +
          "Unlike the built-in connector's fetch_tracks, this is not " +
          "limited to a playlist already shown in the current widget " +
          "session — any playlist id works, and it pages through the full " +
          "track list rather than returning it all at once uncapped.",
        inputSchema: {
          playlist_id: z.string().describe("The Spotify playlist id."),
          ...PAGING_SCHEMA,
        },
      },
      async ({ playlist_id, limit, cursor }) => {
        const provider = await this.provider();
        const page = await provider.getPlaylistTracks(playlist_id, { limit, cursor });
        return { content: [{ type: "text" as const, text: JSON.stringify(page, null, 2) }] };
      },
    );
  }

  private registerPlaylistWriteTools() {
    this.registerTool(
      "add_tracks_to_playlist",
      {
        description:
          "Add tracks to a playlist. Takes up to 100 track URIs per call. "
          + "The built-in Spotify connector cannot do this at all — it can "
          + "create a new playlist but not edit an existing one.",
        inputSchema: {
          playlist_id: z.string().describe("The Spotify playlist id."),
          uris: z
            .array(z.string())
            .max(PLAYLIST_ADD_MAX_ITEMS)
            .describe("Track URIs, e.g. spotify:track:4iV5W9uYEdYUVa79Axb7Rh."),
          position: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe("Zero-based insertion index. Appends when omitted."),
        },
      },
      async ({ playlist_id, uris, position }) => {
        const provider = await this.requireWrites();
        await provider.addTracksToPlaylist!(playlist_id, uris, { position });
        return {
          content: [
            {
              type: "text" as const,
              text: `Added ${uris.length} track(s) to playlist ${playlist_id}.`,
            },
          ],
        };
      },
    );

    this.registerTool(
      "remove_tracks_from_playlist",
      {
        description:
          "Remove tracks from a playlist. IRREVERSIBLE — Spotify has no undo "
          + "and removed tracks cannot be recovered through the API. Call "
          + "once without `confirm` to see exactly what would be removed and "
          + "receive a confirmation token, then call again passing that token "
          + "as `confirm`. A token authorises one exact removal and cannot be "
          + "replayed against a different playlist or a different track list.",
        inputSchema: {
          playlist_id: z.string().describe("The Spotify playlist id."),
          uris: z.array(z.string()).describe("Track URIs to remove."),
          confirm: z
            .string()
            .optional()
            .describe("The token from the dry run. Omit for the dry run itself."),
        },
      },
      async ({ playlist_id, uris, confirm }) => {
        const provider = await this.requireWrites();
        const operation = describeOperation("remove_tracks_from_playlist", playlist_id, uris);
        const secret = this.env.COOKIE_ENCRYPTION_KEY;
        const now = Date.now();

        if (confirm === undefined) {
          const token = await issueConfirmationToken(secret, operation, now);
          const playlists = await provider.getPlaylists({ limit: PLAYLIST_LOOKUP_LIMIT });
          const named = playlists.items.find((entry) => entry.id === playlist_id);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `DRY RUN — nothing has been removed.\n\n`
                  + `Playlist: ${named ? `"${named.name}"` : playlist_id}\n`
                  + `Tracks to remove: ${uris.length}\n`
                  + uris.map((uri) => `  - ${uri}`).join("\n")
                  + `\n\nTo perform this removal, call again with confirm="${token}". `
                  + `The token is valid for about ten minutes and authorises only `
                  + `this exact removal.`,
              },
            ],
          };
        }

        if (!(await isValidConfirmation(secret, operation, confirm, now))) {
          throw new Error(
            "That confirmation token does not authorise this removal. A token is "
            + "tied to one playlist and one exact set of tracks, and expires after "
            + "about ten minutes. Run the dry run again to get a fresh one.",
          );
        }

        await provider.removeTracksFromPlaylist!(playlist_id, uris);
        return {
          content: [
            {
              type: "text" as const,
              text: `Removed ${uris.length} track(s) from playlist ${playlist_id}.`,
            },
          ],
        };
      },
    );

    this.registerTool(
      "create_playlist",
      {
        description: "Create a new playlist owned by the authenticated user.",
        inputSchema: {
          name: z.string().describe("The playlist's name."),
          description: z.string().optional().describe("Optional description."),
          public: z
            .boolean()
            .optional()
            .describe("Whether the playlist is public. Spotify defaults to public."),
        },
      },
      async ({ name, description, public: isPublic }) => {
        const provider = await this.requireWrites();
        const created = await provider.createPlaylist!({ name, description, isPublic });
        return { content: [{ type: "text" as const, text: JSON.stringify(created, null, 2) }] };
      },
    );

    this.registerTool(
      "update_playlist_details",
      {
        description:
          "Rename a playlist, or change its description or visibility. Does "
          + "not touch its tracks.",
        inputSchema: {
          playlist_id: z.string().describe("The Spotify playlist id."),
          name: z.string().optional().describe("New name."),
          description: z.string().optional().describe("New description."),
          public: z.boolean().optional().describe("New visibility."),
        },
      },
      async ({ playlist_id, name, description, public: isPublic }) => {
        const provider = await this.requireWrites();
        await provider.updatePlaylistDetails!(playlist_id, { name, description, isPublic });
        return {
          content: [{ type: "text" as const, text: `Updated playlist ${playlist_id}.` }],
        };
      },
    );
  }

  private registerLibraryWriteTools() {
    this.registerTool(
      "save_to_library",
      {
        description:
          "Save tracks, albums, shows or episodes to the library. Takes up "
          + "to 40 Spotify URIs of any saveable type per call.",
        inputSchema: {
          uris: z
            .array(z.string())
            .max(LIBRARY_WRITE_MAX_ITEMS)
            .describe("Spotify URIs, e.g. spotify:track:... or spotify:album:..."),
        },
      },
      async ({ uris }) => {
        const provider = await this.requireWrites();
        await provider.saveToLibrary!(uris);
        return {
          content: [{ type: "text" as const, text: `Saved ${uris.length} item(s) to the library.` }],
        };
      },
    );

    this.registerTool(
      "remove_from_library",
      {
        description:
          "Remove tracks, albums, shows or episodes from the library. "
          + "IRREVERSIBLE in the way that matters: re-saving an item does not "
          + "restore its original added-at date, so its place in the library "
          + "is lost. Call once without `confirm` for a dry run and a token, "
          + "then again with that token.",
        inputSchema: {
          uris: z.array(z.string()).max(LIBRARY_WRITE_MAX_ITEMS).describe("Spotify URIs to remove."),
          confirm: z
            .string()
            .optional()
            .describe("The token from the dry run. Omit for the dry run itself."),
        },
      },
      async ({ uris, confirm }) => {
        const provider = await this.requireWrites();
        const operation = describeOperation("remove_from_library", "library", uris);
        const secret = this.env.COOKIE_ENCRYPTION_KEY;
        const now = Date.now();

        if (confirm === undefined) {
          const token = await issueConfirmationToken(secret, operation, now);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `DRY RUN — nothing has been removed.\n\n`
                  + `Items to remove from the library: ${uris.length}\n`
                  + uris.map((uri) => `  - ${uri}`).join("\n")
                  + `\n\nTo perform this removal, call again with confirm="${token}".`,
              },
            ],
          };
        }

        if (!(await isValidConfirmation(secret, operation, confirm, now))) {
          throw new Error(
            "That confirmation token does not authorise this removal. A token is "
            + "tied to one exact set of items and expires after about ten minutes. "
            + "Run the dry run again to get a fresh one.",
          );
        }

        await provider.removeFromLibrary!(uris);
        return {
          content: [
            { type: "text" as const, text: `Removed ${uris.length} item(s) from the library.` },
          ],
        };
      },
    );
  }

  private registerPlaybackTools() {
    this.registerTool(
      "get_currently_playing",
      {
        description:
          "What is playing right now, and on which device. Returns null when "
          + "nothing is playing.",
        inputSchema: {},
      },
      async () => {
        const provider = await this.provider();
        const playing = await provider.getCurrentlyPlaying!();
        return { content: [{ type: "text" as const, text: JSON.stringify(playing, null, 2) }] };
      },
    );

    this.registerTool(
      "list_devices",
      {
        description:
          "Every device Spotify Connect can play to, and which is active. "
          + "Playback commands need an active device, so call this first when "
          + "`play` reports there is none.",
        inputSchema: {},
      },
      async () => {
        const provider = await this.provider();
        const devices = await provider.listDevices!();
        return { content: [{ type: "text" as const, text: JSON.stringify(devices, null, 2) }] };
      },
    );

    this.registerTool(
      "play",
      {
        description:
          "Start or resume playback. Pass any Spotify URI — a track, album, "
          + "artist or playlist — and it plays; omit the URI to resume what is "
          + "already loaded. Requires Spotify Premium and an active device; "
          + "call `list_devices` and `transfer_playback` if there is none.",
        inputSchema: {
          uri: z
            .string()
            .optional()
            .describe("Track, album, artist or playlist URI. Omit to resume."),
          device_id: z.string().optional().describe("Target device. Uses the active one when omitted."),
        },
      },
      async ({ uri, device_id }) => {
        const provider = await this.provider();
        await provider.play!({ uri, deviceId: device_id });
        return {
          content: [
            { type: "text" as const, text: uri === undefined ? "Resumed playback." : `Playing ${uri}.` },
          ],
        };
      },
    );

    this.registerTool(
      "pause",
      {
        description: "Pause playback. Requires Spotify Premium.",
        inputSchema: {
          device_id: z.string().optional().describe("Target device. Uses the active one when omitted."),
        },
      },
      async ({ device_id }) => {
        const provider = await this.provider();
        await provider.pause!({ deviceId: device_id });
        return { content: [{ type: "text" as const, text: "Paused." }] };
      },
    );

    this.registerTool(
      "skip_to_next",
      {
        description: "Skip to the next track. Requires Spotify Premium.",
        inputSchema: {
          device_id: z.string().optional().describe("Target device. Uses the active one when omitted."),
        },
      },
      async ({ device_id }) => {
        const provider = await this.provider();
        await provider.skipToNext!({ deviceId: device_id });
        return { content: [{ type: "text" as const, text: "Skipped to the next track." }] };
      },
    );

    this.registerTool(
      "skip_to_previous",
      {
        description: "Skip to the previous track. Requires Spotify Premium.",
        inputSchema: {
          device_id: z.string().optional().describe("Target device. Uses the active one when omitted."),
        },
      },
      async ({ device_id }) => {
        const provider = await this.provider();
        await provider.skipToPrevious!({ deviceId: device_id });
        return { content: [{ type: "text" as const, text: "Skipped to the previous track." }] };
      },
    );

    this.registerTool(
      "transfer_playback",
      {
        description:
          "Move playback to another device. Use when `play` reports no active "
          + "device: call `list_devices`, pick one, then transfer to it.",
        inputSchema: {
          device_id: z.string().describe("The device to move playback to."),
          play: z
            .boolean()
            .optional()
            .describe("Start playing on arrival rather than keeping the current state."),
        },
      },
      async ({ device_id, play }) => {
        const provider = await this.provider();
        await provider.transferPlayback!(device_id, { play });
        return { content: [{ type: "text" as const, text: `Moved playback to device ${device_id}.` }] };
      },
    );
  }

  /**
   * The provider, having checked it implements writes.
   *
   * Write methods are optional on `MediaProvider` so a read-only provider can
   * exist without declaring methods it would only throw from. That makes them
   * possibly-undefined at every call site, so the check happens once here and
   * the tools assert afterwards.
   */
  private async requireWrites(): Promise<MediaProvider> {
    const provider = await this.provider();
    if (provider.addTracksToPlaylist === undefined) {
      throw new Error(
        `The ${provider.name} provider is read-only and cannot modify playlists or the library.`,
      );
    }
    return provider;
  }
}

/** How many playlists to scan when naming one for a dry run. */
const PLAYLIST_LOOKUP_LIMIT = 50;

export { buildFailure };
export type { Env, UserProps } from "./types";
