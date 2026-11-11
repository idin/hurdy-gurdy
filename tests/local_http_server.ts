import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real HTTP server on 127.0.0.1 that plays one upstream service (MusicBrainz,
 * ListenBrainz), so a client's `fetch` crosses a real socket instead of hitting
 * a replaced `globalThis.fetch` or an injected stub.
 *
 * `providers/spotify/local_spotify_server.ts` does the same for Spotify, whose
 * path prefix and token endpoint it knows; this one knows nothing about the
 * service it plays, so each test chooses the base path its client expects.
 *
 * It needs Node's `node:http`, which the Workers test runtime does not
 * implement, so the tests that use it are named `*.network.test.ts` and run in
 * the `network` vitest project (a Node environment).
 */

export type RecordedHttpRequest = {
  method: string;
  /** Path without the query string, exactly as sent (percent-encoding intact). */
  path: string;
  /** Request target as sent: path plus raw query string. */
  target: string;
  query: URLSearchParams;
  /** Header names are lower-case; a repeated header is joined with ", ". */
  headers: Record<string, string>;
};

export type HttpReply = {
  status: number;
  /** Sent as JSON unless it is already a string. */
  body?: unknown;
  /** Extra response headers, such as ListenBrainz's `X-RateLimit-Remaining`. */
  headers?: Record<string, string>;
};

export type HttpResponder = (request: RecordedHttpRequest) => HttpReply;

export type LocalHttpServer = {
  /** `http://127.0.0.1:<port>`, with no trailing slash; append the base path the client expects. */
  origin: string;
  requests: RecordedHttpRequest[];
  close: () => Promise<void>;
};

function joinHeaders(incoming: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) {
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return headers;
}

/**
 * Start the server.
 *
 * @param options.respond - Decides each reply from the recorded request.
 * @returns Its origin, every request it received so far, and a closer.
 */
export async function startLocalHttpServer(options: { respond: HttpResponder }): Promise<LocalHttpServer> {
  const requests: RecordedHttpRequest[] = [];

  const server: Server = createServer((incoming, outgoing) => {
    const target = incoming.url ?? "/";
    const url = new URL(target, "http://127.0.0.1");
    const recorded: RecordedHttpRequest = {
      method: incoming.method ?? "GET",
      path: target.split("?")[0],
      target,
      query: url.searchParams,
      headers: joinHeaders(incoming),
    };
    requests.push(recorded);

    const reply = options.respond(recorded);
    if (reply.body === undefined) {
      outgoing.writeHead(reply.status, reply.headers).end();
      return;
    }
    outgoing.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
    outgoing.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Keep-alive sockets from `fetch` would otherwise hold close() open.
        server.closeAllConnections();
      }),
  };
}
