import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Pool + timeout defaults for the postgres.js client.
 *
 * Why these exist (prod incident, 2026-06-08): the client used to be created
 * with *no* limits — postgres.js then defaults to `max: 10` per process and
 * **no statement/connect/idle timeouts**. With 2 prod replicas that is only ~20
 * DB connections for the entire fleet, and postgres.js has **no acquire/queue
 * timeout**: once every connection is busy, further queries queue *forever*
 * until the caller gives up. A single stuck query therefore pinned a connection
 * indefinitely and cascaded into fleet-wide "Request timed out after 30s" on
 * completely unrelated endpoints (sandbox-health, secrets, change-requests,
 * iam/effective, …) — because they were all just waiting for a free connection.
 *
 * The fix has two parts:
 *   1. `statement_timeout` — the key anti-cascade lever. Caps how long any
 *      single statement (and thus a checked-out connection) can run, so a stuck
 *      query frees its slot and the queue drains instead of hanging the fleet.
 *      (Investigation found real offenders: an unindexed 21M-row audit scan at
 *      80–120s, and account-deletion sweeps at 36–64s, each pinning a connection
 *      for up to the 2-min server statement_timeout.)
 *   2. A modestly larger, env-tunable `max` so normal concurrent page loads
 *      (one IAM page fans out ~15-20 parallel queries) don't exhaust the pool.
 *
 * SIZING: prod connects DIRECTLY to Postgres (db.<ref>.supabase.co:5432), NOT
 * the Supavisor pooler — so every client connection is one real backend, capped
 * by the server's `max_connections` (240 on the current instance, only ~23 in
 * use at rest). Keep `POOL_MAX * max_replicas` comfortably under that ceiling
 * with headroom for other consumers: at the current autoscale max of 10
 * replicas, 15 * 10 = 150 < 240. If replica count or pool size grows, move app
 * traffic to the transaction pooler (port 6543) instead of raising this further.
 *
 * All knobs are env-overridable so prod can tune without a code change. The
 * app's background workers (maintenance sweeps, migration workers) only ever run
 * small batched/indexed statements, so the 25s cap is safe for them; if a future
 * job needs a longer single statement it should `SET LOCAL statement_timeout`
 * inside its own transaction rather than raising this request-path default.
 */
const POOL_MAX = intFromEnv('DB_POOL_MAX', 15);
const IDLE_TIMEOUT_S = intFromEnv('DB_IDLE_TIMEOUT_S', 30);
const CONNECT_TIMEOUT_S = intFromEnv('DB_CONNECT_TIMEOUT_S', 10);
const MAX_LIFETIME_S = intFromEnv('DB_MAX_LIFETIME_S', 60 * 30); // 30 min
// 25s — deliberately *below* the frontend's 30s client abort so a stuck query
// is killed and its connection returned to the pool *before* clients give up,
// letting queued requests actually complete instead of all riding to 30s. Still
// enormous for any single OLTP statement; background jobs that legitimately need
// longer should `SET LOCAL statement_timeout` inside their own transaction.
const STATEMENT_TIMEOUT_MS = intFromEnv('DB_STATEMENT_TIMEOUT_MS', 25_000);

/**
 * Create a Drizzle database client.
 *
 * @param databaseUrl - PostgreSQL connection string
 * @param options - Additional postgres.js options (override the defaults below)
 * @returns Drizzle database client with full schema
 */
export function createDb(databaseUrl: string, options?: postgres.Options<{}>) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const client = postgres(databaseUrl, {
    // prepare: false keeps us compatible with the Supabase transaction pooler
    // (Supavisor multiplexes connections, so server-side prepared statements
    // can't be reused). Prod currently uses the DIRECT connection where prepared
    // statements would be fine, but leaving this off keeps a pooler switch a
    // pure connection-string change with no code impact.
    prepare: false,
    max: POOL_MAX,
    idle_timeout: IDLE_TIMEOUT_S,
    connect_timeout: CONNECT_TIMEOUT_S,
    max_lifetime: MAX_LIFETIME_S,
    // statement_timeout is a server-side GUC (milliseconds) applied to every
    // connection at startup. This is what stops a single hung query from
    // pinning a pooled connection forever and starving the whole fleet.
    connection: {
      statement_timeout: STATEMENT_TIMEOUT_MS,
    },
    ...options,
  });

  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
