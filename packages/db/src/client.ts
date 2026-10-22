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
 * a leader-election connection, a base-move LISTEN/NOTIFY connection, and a
 * transient startup schema probe. The capacity invariant in
 * apps/api/src/shared/database-capacity.test.ts accounts for all five sources
 * and preserves a non-API reserve. If replica count or pool size grows, update
 * that invariant before changing this default.
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
 * Opt-in: send Drizzle statements as server-side prepared statements.
 *
 * Two switches have to agree, and each alone is a no-op. postgres.js prepares a
 * statement only when the CONNECTION option `prepare` is true and the query's
 * own option is not false. Drizzle calls `client.unsafe(query, params)`, whose
 * query option defaults to false. `createDb` sets both (`preparedSql` for the
 * second). Unprepared, every parameterized statement costs two round trips
 * (Parse/Describe, then Bind/Execute). Prepared, a statement a connection has
 * seen costs one.
 *
 * Off by default, and a per-environment decision:
 *  - it needs a direct or session-mode connection. A transaction pooler
 *    (Supavisor port 6543) multiplexes connections and breaks it;
 *  - after ~5 executions PostgreSQL may switch a prepared statement to a
 *    generic plan, which cannot use a partial index whose predicate arrives as
 *    a parameter. Prepared connections therefore set `plan_cache_mode =
 *    force_custom_plan`: every execution is planned for its own parameters, as
 *    an unprepared one is, and only the extra round trip goes;
 *  - the per-connection statement cache has no size limit. `DB_MAX_LIFETIME_S`
 *    (30 min) bounds it.
 */
const PREPARE_STATEMENTS = process.env.DB_PREPARE_STATEMENTS === 'true';

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
 * Make every Drizzle statement on `sql` a prepared one: `unsafe(query, params)`
 * gets `{ prepare: true }` unless the caller passed options of its own. Applies
 * inside `begin` and `savepoint` too. Everything else passes through.
 */
export function preparedSql<S extends object>(sql: S): S {
  return new Proxy(sql, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'unsafe') {
        return (query: unknown, params: unknown = [], options: unknown = { prepare: true }) =>
          (value as (...a: unknown[]) => unknown).call(target, query, params, options);
      }
      if (property === 'begin' || property === 'savepoint') {
        return (...args: unknown[]) => {
          const last = args.length - 1;
          const callback = args[last];
          if (typeof callback === 'function') {
            args[last] = (inner: object) => callback(preparedSql(inner));
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
}

/**
 * True for the postgres.js connection-phase failure: the attempt to establish
 * a connection exceeded `connect_timeout` and the statement was never sent to
 * the server. The error is a plain Error carrying the driver's own code — not
 * a `PostgresError` — so SQLSTATE-based classification never recognizes it.
 */
export function isConnectTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'CONNECT_TIMEOUT'
  );
}

/**
 * Retry a statement whose connection never established.
 *
 * postgres.js has no driver-level retry: when a connection attempt exceeds
 * `connect_timeout`, the query that drew the connection rejects with
 * `Error: write CONNECT_TIMEOUT …` and is gone. During a brief database
 * degradation (2026-09-15, 2026-10-16 prod) every statement unlucky enough to
 * draw a connecting socket failed hard and paged as `Failed query: <SQL>` —
 * with the SQL of whatever statement was the victim, not of any real query
 * problem.
 *
 * The statement provably never reached the server, so exactly ONE fresh
 * attempt on a new connection is safe — no double execution, no duplicate
 * side effects. `begin`/`savepoint` are deliberately not retried: their
 * callback may have already run, and a transaction's statements use the
 * reserved connection postgres.js manages itself, which never passes through
 * here. Only the awaited statement path Drizzle uses is retried
 * (`unsafe(...)` — with its `.values()` flag — then
 * `then`/`catch`/`finally`); builder methods for streaming or cursor
 * execution pass through unretried.
 */
function retriedQuery<Q extends object>(freshAttempt: () => Q): Q {
  const attempt = freshAttempt();
  let valuesShape = false;
  let chain: Promise<unknown> | null = null;
  // One chain per statement: the query starts on the first subscriber and
  // every subscriber rides the same (at most retried once) outcome.
  const ensureChain = () => {
    if (!chain) {
      chain = Promise.resolve(attempt as unknown as Promise<unknown>).catch((error) => {
        if (!isConnectTimeoutError(error)) throw error;
        const retry = freshAttempt() as unknown as Q & { values: () => unknown };
        if (valuesShape) retry.values();
        return retry;
      });
    }
    return chain;
  };
  return new Proxy(attempt, {
    get(target, property, receiver) {
      if (property === 'values') {
        // The result-shape flag: apply it to the real query and keep handing
        // out this proxy, so the retry can re-apply it on the fresh attempt.
        return (...args: unknown[]) => {
          valuesShape = true;
          (Reflect.get(target, property) as (...a: unknown[]) => unknown).apply(target, args);
          return receiver;
        };
      }
      if (property === 'then' || property === 'catch' || property === 'finally') {
        // Route the caller's settle calls through this proxy's retry chain —
        // never to the query's own settle methods, which a layer below (e.g.
        // instrumentSql) may already have wrapped. The chain adopts the query
        // (Promise.resolve), which calls its wrapped `then` and so still
        // fires that layer's dispatch hook; the caller's resolvers then see
        // the retried outcome.
        return (...args: unknown[]) =>
          (ensureChain() as unknown as Record<string, (...a: unknown[]) => unknown>)[property](...args);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Q;
}

/**
 * Give every awaited statement on `sql` one fresh attempt when its connection
 * never established (see {@link retriedQuery}). Wraps the outermost layer:
 * a retried attempt goes through the same preparation and instrumentation as
 * the first. Transactions are not retried.
 */
export function connectRetry<S extends object>(sql: S): S {
  return new Proxy(sql, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'unsafe') {
        return (...args: unknown[]) =>
          retriedQuery(() => (value as (...a: unknown[]) => object).apply(target, args));
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

  // Off unless `DB_PREPARE_STATEMENTS=true` or the caller asks. Off keeps us
  // compatible with the Supabase transaction pooler (Supavisor multiplexes
  // connections, so server-side prepared statements can't be reused). Prod
  // uses the DIRECT connection, where prepared statements work.
  const prepare = options?.prepare ?? PREPARE_STATEMENTS;
  const client = postgres(databaseUrl, {
    max: POOL_MAX,
    idle_timeout: IDLE_TIMEOUT_S,
    connect_timeout: CONNECT_TIMEOUT_S,
    max_lifetime: MAX_LIFETIME_S,
    // statement_timeout is a server-side GUC (milliseconds) applied to every
    // connection at startup. This is what stops a single hung query from
    // pinning a pooled connection forever and starving the whole fleet.
    connection: {
      statement_timeout: STATEMENT_TIMEOUT_MS,
      ...(prepare ? { plan_cache_mode: 'force_custom_plan' } : {}),
    },
    ...options,
    prepare,
  });

  const statements = prepare ? preparedSql(client as AnySql) : client;
  const observed = hooks?.onQuery ? instrumentSql(statements as AnySql, hooks.onQuery) : statements;
  const resilient = connectRetry(observed as AnySql);
  return drizzle(resilient as typeof client, { schema });
}

export type Database = ReturnType<typeof createDb>;
