import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { DEFAULT_DB_POOL_MAX } from './connection-defaults';
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
 *   2. An env-tunable `max` so normal concurrent page loads can run without
 *      letting a rolling deployment exhaust the PostgreSQL server.
 *
 * SIZING: prod connects DIRECTLY to Postgres (db.<ref>.supabase.co:5432), NOT
 * the Supavisor pooler. Every client connection consumes one real backend.
 * PostgreSQL exposes 237 non-reserved slots. ECS can overlap 10 old tasks and
 * 10 new tasks during a rolling deployment. The API also owns an audit pool,
 * a leader-election connection, and a transient startup schema probe. The
 * capacity invariant in apps/api/src/shared/database-capacity.test.ts accounts
 * for all four sources and preserves a non-API reserve. If replica count or
 * pool size grows, update that invariant before changing this default.
 *
 * All knobs are env-overridable so prod can tune without a code change. The
 * app's background workers (maintenance sweeps, migration workers) only ever run
 * small batched/indexed statements, so the 25s cap is safe for them; if a future
 * job needs a longer single statement it should `SET LOCAL statement_timeout`
 * inside its own transaction rather than raising this request-path default.
 */
const POOL_MAX = intFromEnv('DB_POOL_MAX', DEFAULT_DB_POOL_MAX);
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
 * Observability hooks for {@link createDb}.
 *
 * `onQuery` runs when a statement is dispatched (including the wait for a pool
 * connection) and returns the function called when it settles. A transaction
 * is reported as one operation spanning BEGIN..COMMIT, plus one per statement
 * inside it. Hooks must never throw; they run on every query.
 */
export interface DbHooks {
  onQuery?: () => () => void;
}

type AnySql = postgres.Sql<{}>;

const QUERY_SETTLE_METHODS = ['then', 'catch', 'finally'] as const;

/**
 * Report a lazily-executed postgres.js query to `onQuery`. A postgres.js
 * `Query` only starts on its first `then`/`catch`/`finally`, so the clock
 * starts there. The settle observer uses the base `Promise.prototype.then`,
 * which neither starts the query a second time nor leaves a rejection unhandled.
 */
function observeQuery<Q extends object>(query: Q, onQuery: () => () => void): Q {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    const end = onQuery();
    Promise.prototype.then.call(query, end, end);
  };
  const target = query as Record<string, unknown>;
  for (const method of QUERY_SETTLE_METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = function (this: unknown, ...args: unknown[]) {
      start();
      return (original as (...a: unknown[]) => unknown).apply(query, args);
    };
  }
  return query;
}

/**
 * Wrap the three postgres.js entry points Drizzle uses — `unsafe` (every
 * statement), `begin` (transactions) and `savepoint` (nested transactions) —
 * so `onQuery` sees every round trip. Everything else passes through.
 */
export function instrumentSql<S extends object>(sql: S, onQuery: () => () => void): S {
  return new Proxy(sql, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'unsafe') {
        return (...args: unknown[]) => observeQuery((value as (...a: unknown[]) => object).apply(target, args), onQuery);
      }
      if (property === 'begin' || property === 'savepoint') {
        return (...args: unknown[]) => {
          const last = args.length - 1;
          const callback = args[last];
          if (typeof callback === 'function') {
            args[last] = (inner: object) => callback(instrumentSql(inner, onQuery));
          }
          const end = onQuery();
          const pending = (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          pending.then(end, end);
          return pending;
        };
      }
      return value;
    },
  });
}

/**
 * Create a Drizzle database client.
 *
 * @param databaseUrl - PostgreSQL connection string
 * @param options - Additional postgres.js options (override the defaults below)
 * @param hooks - Optional observability hooks (see {@link DbHooks})
 * @returns Drizzle database client with full schema
 */
export function createDb(databaseUrl: string, options?: postgres.Options<{}>, hooks?: DbHooks) {
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

  const observed = hooks?.onQuery ? instrumentSql(client as AnySql, hooks.onQuery) : client;
  return drizzle(observed as typeof client, { schema });
}

export type Database = ReturnType<typeof createDb>;
