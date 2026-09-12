import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { version as PACKAGE_VERSION } from "../package.json";

import { SpotifyProvider } from "./providers/spotify/spotify_provider";
import { getAccessToken } from "./providers/spotify/spotify_session";
import type { SearchType } from "./providers/media_provider";
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

export class MusixBoxMCP extends McpAgent<Env, unknown, UserProps> {
  server = new McpServer({
    name: "musix-box",
    title: "Musix Box",
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
}

export { buildFailure };
export type { Env, UserProps } from "./types";
