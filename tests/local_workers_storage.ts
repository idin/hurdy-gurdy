import { Miniflare } from "miniflare";

/**
 * Cloudflare's own local D1 and KV (Miniflare, the engine under `wrangler dev`
 * and the Workers test pool), started from Node.
 *
 * The `network` tests run in Node because they need a real HTTP server, and
 * Node has no `cloudflare:test` bindings. This gives them the same real D1 and
 * KV the Workers tests get, not a hand-written stand-in.
 */

/** Never reached: Miniflare needs a script to start, and these tests only use its storage. */
const IDLE_WORKER_SCRIPT = "export default { fetch() { return new Response('idle'); } }";

const DATABASE_BINDING = "MEDIA_CACHE";
const KV_BINDING = "SPOTIFY_TOKENS";

export type LocalWorkersStorage = {
  database: D1Database;
  kv: KVNamespace;
  dispose: () => Promise<void>;
};

/**
 * Start an empty D1 database and KV namespace, in memory.
 *
 * @returns The bindings, and a disposer the test must await when it finishes.
 */
export async function startLocalWorkersStorage(): Promise<LocalWorkersStorage> {
  const miniflare = new Miniflare({
    modules: true,
    script: IDLE_WORKER_SCRIPT,
    compatibilityDate: "2025-03-10",
    d1Databases: [DATABASE_BINDING],
    kvNamespaces: [KV_BINDING],
  });
  const database = (await miniflare.getD1Database(DATABASE_BINDING)) as unknown as D1Database;
  const kv = (await miniflare.getKVNamespace(KV_BINDING)) as unknown as KVNamespace;
  return { database, kv, dispose: () => miniflare.dispose() };
}
