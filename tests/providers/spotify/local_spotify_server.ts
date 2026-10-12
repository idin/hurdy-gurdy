import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real HTTP server on 127.0.0.1 that plays Spotify's part, so the client's
 * `fetch` crosses a real socket instead of hitting a replaced `globalThis.fetch`.
 *
 * It needs Node's `node:http`, which the Workers test runtime does not
 * implement, so the tests that use it are named `*.network.test.ts` and run in
 * the `network` vitest project (a Node environment).
 */

/** The prefix Spotify's Web API lives under; the server answers below it. */
const API_PATH_PREFIX = "/v1";

/** Where the server answers token requests, standing in for accounts.spotify.com/api/token. */
const TOKEN_PATH = "/api/token";

export type RecordedRequest = {
  method: string;
  /** Path below `/v1` for API calls, or the full path for any other request. */
  path: string;
  /** Path with its query string, below `/v1` for API calls. */
  pathAndQuery: string;
  query: URLSearchParams;
  /** Parsed JSON when the body is JSON, the raw text otherwise, `undefined` when empty. */
  body: unknown;
};

export type ServerReply = {
  status: number;
  /** Sent as is; a 204 sends none. */
  body?: unknown;
};

export type Responder = (request: RecordedRequest) => ServerReply;

export type LocalSpotifyServer = {
  /** Pass as `apiBaseUrl` to the Spotify client. */
  apiBaseUrl: string;
  /** Pass as `tokenUrl` to the Spotify OAuth functions. */
  tokenUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
};

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Start the server.
 *
 * @param options.respond - Decides each reply from the recorded request.
 * @returns Its base URLs, every request it received so far, and a closer.
 */
export async function startLocalSpotifyServer(options: { respond: Responder }): Promise<LocalSpotifyServer> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    const isApiCall = url.pathname.startsWith(`${API_PATH_PREFIX}/`);
    const path = isApiCall ? url.pathname.slice(API_PATH_PREFIX.length) : url.pathname;
    const recorded: RecordedRequest = {
      method: incoming.method ?? "GET",
      path,
      pathAndQuery: `${path}${url.search}`,
      query: url.searchParams,
      body: await readBody(incoming),
    };
    requests.push(recorded);

    const reply = options.respond(recorded);
    if (reply.body === undefined || reply.status === 204) {
      outgoing.writeHead(reply.status).end();
      return;
    }
    outgoing.writeHead(reply.status, { "Content-Type": "application/json" });
    outgoing.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    apiBaseUrl: `${origin}${API_PATH_PREFIX}`,
    tokenUrl: `${origin}${TOKEN_PATH}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Keep-alive sockets from `fetch` would otherwise hold close() open.
        server.closeAllConnections();
      }),
  };
}
