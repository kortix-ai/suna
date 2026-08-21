import { createDb, type Database } from '@kortix/db';
import { config } from '../config';
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

const AUDIT_POOL_MAX = intFromEnv('DB_AUDIT_POOL_MAX', 3);
const AUDIT_STATEMENT_TIMEOUT_MS = intFromEnv('DB_AUDIT_STATEMENT_TIMEOUT_MS', 10_000);

let dedicatedPool: Database | null = null;
function dedicated(): Database {
  if (!dedicatedPool) {
    dedicatedPool = createDb(config.DATABASE_URL, {
      max: AUDIT_POOL_MAX,
      connection: { statement_timeout: AUDIT_STATEMENT_TIMEOUT_MS },
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
