/**
 * Background-worker leader election (lease-table based).
 *
 * The API runs as N replicas on ECS Fargate (prod: min 2, up to 10). Request-
 * path code is stateless and safe on every replica, but the SINGLETON background
 * loops (cron trigger scheduler, project maintenance, warm-pool reconcile,
 * legacy-migration worker, snapshot pre-build, grant-expiry sweep) must run on
 * exactly ONE replica — otherwise every cron trigger fires N times (N duplicate
 * paid agent sessions + duplicate external side effects), the warm pool is
 * over-provisioned, etc.
 *
 * We elect a single leader with a TTL lease row in `kortix.worker_leader_lease`.
 * One atomic UPSERT both acquires (when the row is absent or its lease expired)
 * and renews (when we already own it); a non-owning live lease yields no row, so
 * the caller knows it lost. The leader renews well within the TTL; if it dies or
 * partitions, the lease expires and another replica takes over within ~TTL.
 *
 * Why a lease table and NOT pg_advisory_lock: prod connects through the Supabase
 * pooler (`prepare: false`), which in transaction mode does not pin a backend
 * across statements — so SESSION-level advisory locks are unreliable there. A
 * lease row is just a normal upsert and works identically through any pooler,
 * with 1 replica or many. With no DATABASE_URL (self-host single node) we skip
 * coordination entirely and run as the sole leader.
 */

import os from 'node:os';
import postgres from 'postgres';
import { config } from '../config';
import { logger } from '../lib/logger';

const LOCK_KEY = 'background-workers';

// TTL must comfortably exceed RENEW_INTERVAL so a single slow/missed renew never
// drops leadership. Takeover by another replica happens ~TTL after the leader
// stops renewing (death/partition/deploy without graceful release).
const TTL_MS = 60_000;
const RENEW_INTERVAL_MS = 20_000;
const ACQUIRE_RETRY_MS = 15_000;

export interface LeaderElectionHandlers {
  /** Called once when this node becomes leader (start singleton workers). */
  onAcquire: () => void | Promise<void>;
  /** Called when this node loses leadership (stop singleton workers). */
  onRelease: () => void | Promise<void>;
}

// ─── Pure helpers (unit-tested without a DB) ─────────────────────────────────

/**
 * Did our acquire/renew UPSERT win? The statement RETURNs a row only when it
 * inserted or updated — i.e. we now hold the lease. A non-owning live lease
 * matches neither ON CONFLICT predicate, so no row comes back.
 */
export function interpretAcquireResult(
  rows: ReadonlyArray<{ owner_id: string }>,
  ownerId: string,
): boolean {
  return rows.length > 0 && rows[0]!.owner_id === ownerId;
}

/**
 * A current leader that can't confirm a renew (DB unreachable) must step down
 * before its lease expires, so a peer can safely take over without two leaders
 * overlapping. Demote once the lease we last secured has lapsed.
 */
export function shouldDemote(
  lastRenewSuccessMs: number,
  nowMs: number,
  ttlMs: number = TTL_MS,
): boolean {
  return nowMs - lastRenewSuccessMs >= ttlMs;
}

// ─── Runtime state ───────────────────────────────────────────────────────────

const ownerId = `${os.hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

let sql: ReturnType<typeof postgres> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let leader = false;
let lastRenewSuccessMs = 0;
let handlers: LeaderElectionHandlers | null = null;
let tableReady = false;

export function isLeader(): boolean {
  return leader;
}

export function leaderOwnerId(): string {
  return ownerId;
}

async function ensureLeaseTable(): Promise<void> {
  if (tableReady || !sql) return;
  // Idempotent + self-contained so coordination works even where the schema is
  // managed externally (prod ensureSchema is a no-op). Migration
  // 00000000000110_worker_leader_lease.sql also records it for the formal
  // pipeline; if this role lacks CREATE (table already provided by the
  // migration) we swallow the error and let the upsert be the real gate.
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS kortix.worker_leader_lease (
        lock_key   text PRIMARY KEY,
        owner_id   text        NOT NULL,
        expires_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  } catch (err) {
    logger.warn('[leader] lease-table ensure skipped (assuming migration provides it)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  tableReady = true;
}

async function acquireOrRenew(): Promise<boolean> {
  if (!sql) return false;
  await ensureLeaseTable();
  const ttlSec = Math.ceil(TTL_MS / 1000);
  const rows = await sql<{ owner_id: string }[]>`
    INSERT INTO kortix.worker_leader_lease AS l (lock_key, owner_id, expires_at, updated_at)
    VALUES (${LOCK_KEY}, ${ownerId}, now() + make_interval(secs => ${ttlSec}), now())
    ON CONFLICT (lock_key) DO UPDATE
      SET owner_id   = EXCLUDED.owner_id,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
      WHERE l.owner_id = EXCLUDED.owner_id OR l.expires_at < now()
    RETURNING owner_id
  `;
  return interpretAcquireResult(rows, ownerId);
}

async function promote(): Promise<void> {
  if (leader) return;
  leader = true;
  logger.info('[leader] acquired background-worker leadership', { ownerId });
  try {
    await handlers?.onAcquire();
  } catch (err) {
    logger.error('[leader] onAcquire failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function demote(reason: string): Promise<void> {
  if (!leader) return;
  leader = false;
  logger.warn('[leader] released background-worker leadership', { ownerId, reason });
  try {
    await handlers?.onRelease();
  } catch (err) {
    logger.error('[leader] onRelease failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function tick(): Promise<void> {
  if (!running) return;
  let nextDelay = leader ? RENEW_INTERVAL_MS : ACQUIRE_RETRY_MS;
  try {
    const won = await acquireOrRenew();
    if (won) {
      lastRenewSuccessMs = Date.now();
      await promote();
    } else if (leader) {
      // Someone else holds a live lease — step down immediately.
      await demote('lease taken by another replica');
    }
  } catch (err) {
    logger.error('[leader] lease tick failed', { error: err instanceof Error ? err.message : String(err) });
    // Can't confirm leadership; step down once our last good lease has lapsed so
    // a healthy peer can take over without overlap. Retry sooner meanwhile.
    if (leader && shouldDemote(lastRenewSuccessMs, Date.now())) {
      await demote('renew failures exceeded lease TTL');
    }
    nextDelay = Math.min(nextDelay, ACQUIRE_RETRY_MS);
  } finally {
    if (running) timer = setTimeout(() => void tick(), nextDelay);
  }
}

/**
 * Begin leader election. Calls handlers.onAcquire on the elected leader and
 * handlers.onRelease if it later loses leadership. Idempotent.
 *
 * With no DATABASE_URL (self-host single node) there's nothing to coordinate, so
 * this node is the sole leader immediately.
 */
export function startLeaderElection(h: LeaderElectionHandlers): void {
  if (running) return;
  running = true;
  handlers = h;

  if (!config.DATABASE_URL) {
    logger.info('[leader] no DATABASE_URL — running as sole leader (single node)');
    void promote();
    return;
  }

  // Dedicated 1-connection client so lease traffic never contends with the app
  // pool. prepare:false matches the Supabase-pooler app client.
  sql = postgres(config.DATABASE_URL, {
    prepare: false,
    max: 1,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });

  logger.info('[leader] starting election', { ownerId, ttlMs: TTL_MS, renewMs: RENEW_INTERVAL_MS });
  void tick();
}

/**
 * Stop election. Releases the lease (best-effort) so a peer takes over at once
 * instead of waiting out the TTL, and stops singleton workers if we were leader.
 */
export async function stopLeaderElection(): Promise<void> {
  if (!running) return;
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const wasLeader = leader;
  await demote('shutdown');
  try {
    if (sql && wasLeader) {
      await sql`DELETE FROM kortix.worker_leader_lease WHERE lock_key = ${LOCK_KEY} AND owner_id = ${ownerId}`;
    }
  } catch (err) {
    logger.warn('[leader] lease release on shutdown failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    try { await sql?.end({ timeout: 5 }); } catch { /* ignore */ }
    sql = null;
    tableReady = false;
  }
}
