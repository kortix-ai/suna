import { createDb, type Database } from '@kortix/db';
import { config } from '../config';

const globalForDb = globalThis as typeof globalThis & {
  __kortixApiDb?: Database;
  __kortixApiDbUrl?: string;
  __kortixAuditDb?: Database;
  __kortixAuditDbUrl?: string;
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// The audit-write path (the request-log queue flush, the OpenCode ingestion
// batch, and the gateway_request_logs write whose trigger inserts an audit row)
// gets its own SMALL, ISOLATED connection pool — separate real backends from the
// main `db`. Rationale (prod incident, Essentia box 2026-08-21): every audit
// insert serializes through a per-session `FOR UPDATE` row lock in the
// `audit_prepare_event` trigger; under normal load a burst convoys those inserts
// for 4-24s each. On the SHARED pool that pinned connections the gateway's auth
// query and every app query needed, so a slow audit write starved the hot path
// and the upstream closed the socket → Caddy "Bad Gateway" (EOF). Isolating the
// convoy into its own 3-backend pool means it can degrade audit completeness
// (best-effort by design) but can NEVER starve auth/app traffic. The shorter
// statement_timeout caps how long a blocked audit insert holds its backend, so
// this pool self-drains every ~10s instead of riding the main 25s cap.
const AUDIT_POOL_MAX = intFromEnv('DB_AUDIT_POOL_MAX', 3);
const AUDIT_STATEMENT_TIMEOUT_MS = intFromEnv('DB_AUDIT_STATEMENT_TIMEOUT_MS', 10_000);

/**
 * Database availability flag.
 * Check this before importing any DB-dependent modules.
 */
export const hasDatabase: boolean = !!config.DATABASE_URL;

/**
 * Database connection.
 *
 * In local mode without DATABASE_URL, this throws on first use.
 * All DB-dependent routes are only loaded when DATABASE_URL is set
 * (see index.ts conditional imports), so this is safe.
 *
 * Typed as non-null Database to avoid null-check noise in every consumer.
 * The runtime guard catches misconfiguration if it ever happens.
 */
function getDb(): Database {
  if (!config.DATABASE_URL) {
    return new Proxy({} as Database, {
      get(_, prop) {
        throw new Error(
          `DATABASE_URL is not configured. Cannot access db.${String(prop)}. ` +
          `This route requires a database connection.`,
        );
      },
    }) as Database;
  }

  if (globalForDb.__kortixApiDb && globalForDb.__kortixApiDbUrl === config.DATABASE_URL) {
    return globalForDb.__kortixApiDb;
  }

  globalForDb.__kortixApiDb = createDb(config.DATABASE_URL);
  globalForDb.__kortixApiDbUrl = config.DATABASE_URL;
  return globalForDb.__kortixApiDb;
}

/**
 * The isolated audit-write pool. Falls back to the main `db` (its throwing
 * proxy) when DATABASE_URL is unset, so local mode behaves identically.
 */
function getAuditDb(): Database {
  if (!config.DATABASE_URL) return getDb();

  if (globalForDb.__kortixAuditDb && globalForDb.__kortixAuditDbUrl === config.DATABASE_URL) {
    return globalForDb.__kortixAuditDb;
  }

  globalForDb.__kortixAuditDb = createDb(config.DATABASE_URL, {
    max: AUDIT_POOL_MAX,
    connection: { statement_timeout: AUDIT_STATEMENT_TIMEOUT_MS },
  });
  globalForDb.__kortixAuditDbUrl = config.DATABASE_URL;
  return globalForDb.__kortixAuditDb;
}

export const db: Database = getDb();

/**
 * Dedicated pool for high-volume, best-effort audit writes. Use this ONLY for
 * the audit event queue flush, OpenCode audit ingestion, and gateway_request_logs
 * writes (whose trigger fans out an audit row). Never route auth/app/billing
 * queries here — the whole point is that this pool may saturate under an audit
 * lock convoy without affecting anything else.
 */
export const auditDb: Database = getAuditDb();
