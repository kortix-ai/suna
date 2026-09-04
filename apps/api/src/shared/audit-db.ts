import type { Database } from '@kortix/db';
import { config } from '../config';
import { DEFAULT_AUDIT_POOL_MAX } from './database-capacity';
import { db } from './db';

/**
 * The dedicated audit-write pool.
 *
 * Why a SEPARATE pool (prod incident, Essentia box 2026-08-21): every audit
 * insert serializes through a per-session `FOR UPDATE` row lock in the
 * `audit_prepare_event` trigger; under a burst those inserts convoy for 4-24s
 * each. On the SHARED `db` pool that pinned connections the gateway's auth query
 * (and every app query) needed, so a slow audit write starved the hot path and
 * the upstream closed the socket → Caddy "Bad Gateway" (EOF). Isolating audit
 * writes onto their own small pool means the convoy can degrade audit
 * completeness (best-effort by design) but can NEVER starve auth/app traffic.
 * The shorter statement_timeout caps how long a blocked audit insert holds its
 * backend, so this pool self-drains every ~10s instead of riding the main 25s.
 *
 * `lock_timeout` (Essentia 2026-08-26): isolation alone did NOT stop the
 * convoy. Every audit row takes a per-session row lock in `audit_prepare_event`
 * that is held to COMMIT, so a blocked insert used to sit on one of only
 * DEFAULT_AUDIT_POOL_MAX (2) backends for the full 10s statement_timeout and
 * then die with 57014. A lock wait is not work — cap it well below the
 * statement budget so a blocked writer returns its connection in ~2.5s (55P03)
 * and the queue behind it drains 4x faster. statement_timeout still covers the
 * non-lock case.
 *
 * Use ONLY for the audit event queue flush, OpenCode audit ingestion, and
 * gateway_request_logs writes (whose trigger fans out an audit row). Never route
 * auth/app/billing queries here.
 */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const AUDIT_POOL_MAX = intFromEnv('DB_AUDIT_POOL_MAX', DEFAULT_AUDIT_POOL_MAX);
export const AUDIT_STATEMENT_TIMEOUT_MS_DEFAULT = 10_000;
const AUDIT_STATEMENT_TIMEOUT_MS = intFromEnv(
  'DB_AUDIT_STATEMENT_TIMEOUT_MS',
  AUDIT_STATEMENT_TIMEOUT_MS_DEFAULT,
);
export const AUDIT_LOCK_TIMEOUT_MS_DEFAULT = 2_500;
const AUDIT_LOCK_TIMEOUT_MS = intFromEnv('DB_AUDIT_LOCK_TIMEOUT_MS', AUDIT_LOCK_TIMEOUT_MS_DEFAULT);

let dedicatedPool: Database | null = null;
function dedicated(): Database {
  if (!dedicatedPool) {
    // Lazy require, NOT a top-level `import { createDb }`: dedicated() only runs
    // in production (auditDb() returns `db` when NODE_ENV=test), and the ~3 unit
    // tests that mock '@kortix/db' without createDb would SyntaxError on a
    // load-time value import. Resolving it here keeps them untouched.
    const { createDb } = require('@kortix/db') as typeof import('@kortix/db');
    dedicatedPool = createDb(config.DATABASE_URL, {
      max: AUDIT_POOL_MAX,
      connection: {
        statement_timeout: AUDIT_STATEMENT_TIMEOUT_MS,
        lock_timeout: AUDIT_LOCK_TIMEOUT_MS,
      },
    });
  }
  return dedicatedPool;
}

/**
 * Resolve the audit client. In production (a real DATABASE_URL, NODE_ENV not
 * `test`) this is the dedicated isolated pool. In unit tests it is the main
 * `db` export — which the ~120 suites that `mock.module('../shared/db', …)`
 * replace, so audit writes route to their mock with NO mock changes.
 *
 * Resolved PER CALL, never captured at module load: `db` is a live ESM binding
 * and mock.module is applied AFTER a test's hoisted imports have already
 * evaluated this module, so a load-time `const` would snapshot the real pool
 * before the mock exists. This is also why we do NOT `import * as` the db module
 * — a namespace import forces the real module to evaluate and defeats the mock
 * for every importer.
 */
export function auditDb(): Database {
  return config.DATABASE_URL && process.env.NODE_ENV !== 'test' ? dedicated() : db;
}

/**
 * PostgreSQL SQLSTATEs that mean "another writer holds what this one needs",
 * not "this write is wrong".
 *
 * `audit_prepare_event` serializes every row of a session behind one
 * `audit_session_sequences` row lock held to COMMIT, so a burst on one session
 * turns into a lock queue. On the audit pool that queue surfaces as 57014
 * (statement_timeout, the Essentia signature: 445 x 500 in 3h, each at ~10s)
 * or — since `lock_timeout` was added — 55P03 at ~2.5s. Callers must report
 * these as retryable backpressure, never as a 500: a 500 makes the sandbox
 * relay retry a batch that has already been rejected, which feeds the convoy
 * that caused it.
 */
const AUDIT_CONTENTION_SQLSTATES = new Set([
  '57014', // query_canceled — statement_timeout fired while queued on a lock
  '55P03', // lock_not_available — lock_timeout fired
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

export function isAuditContentionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && AUDIT_CONTENTION_SQLSTATES.has(code)) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause != null && cause !== error ? isAuditContentionError(cause) : false;
}
