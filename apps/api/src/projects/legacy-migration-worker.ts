/**
 * Resume loop for durable legacy-sandbox migrations.
 *
 * This is the actual durability guarantee. `startMigration` kicks off an initial
 * drive in-process, but that call dies with the process. This loop is what makes
 * a migration *finish* regardless: every tick it finds live runs whose lease has
 * gone stale (crashed worker) or was released after a retryable failure, and
 * re-drives them. driveMigration re-acquires the lease, so it's safe to call on
 * rows another instance might also be scanning — only the lease winner advances.
 */
import { and, inArray, isNull, lt, or } from 'drizzle-orm';
import { legacySandboxMigrations } from '@kortix/db';
import { db } from '../shared/db';
import { logger as appLogger } from '../lib/logger';
import { driveMigration, LEASE_TTL_MS } from './legacy-migration-runner';

type Timer = ReturnType<typeof setInterval>;

const globalForWorker = globalThis as unknown as {
  __kortixLegacyMigrationTimer?: Timer | null;
};

let timer: Timer | null = null;
let running = false;

function intervalMs(): number {
  const raw = Number(process.env.KORTIX_LEGACY_MIGRATION_WORKER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** Max rows to re-drive per tick — bounds DB/SSH load on a backlog. */
function batchSize(): number {
  const raw = Number(process.env.KORTIX_LEGACY_MIGRATION_WORKER_BATCH);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

async function tick(): Promise<void> {
  if (running) return; // never overlap ticks
  running = true;
  try {
    const staleBefore = new Date(Date.now() - LEASE_TTL_MS);
    const candidates = await db
      .select({ migrationId: legacySandboxMigrations.migrationId })
      .from(legacySandboxMigrations)
      .where(and(
        inArray(legacySandboxMigrations.status, ['planned', 'running']),
        or(
          isNull(legacySandboxMigrations.heartbeatAt),
          lt(legacySandboxMigrations.heartbeatAt, staleBefore),
        ),
      ))
      .limit(batchSize());

    for (const { migrationId } of candidates) {
      // Sequential: each drive holds the lease, so there's no benefit to racing
      // them, and it keeps SSH/git load predictable. driveMigration swallows its
      // own per-phase errors into the row; guard anyway so one bad row can't stop
      // the loop.
      try {
        await driveMigration(db, migrationId);
      } catch (err) {
        appLogger.error('[legacy-migration-worker] drive failed', {
          migrationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (candidates.length > 0) {
      appLogger.info('[legacy-migration-worker] re-drove stale migrations', { count: candidates.length });
    }
  } finally {
    running = false;
  }
}

export function startLegacyMigrationWorker(): void {
  if (process.env.KORTIX_LEGACY_MIGRATION_WORKER_ENABLED === 'false') return;
  if (globalForWorker.__kortixLegacyMigrationTimer) {
    clearInterval(globalForWorker.__kortixLegacyMigrationTimer);
  }
  timer = setInterval(() => {
    tick().catch((err) => {
      appLogger.error('[legacy-migration-worker] tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs());
  globalForWorker.__kortixLegacyMigrationTimer = timer;
}

export function stopLegacyMigrationWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (globalForWorker.__kortixLegacyMigrationTimer) {
    clearInterval(globalForWorker.__kortixLegacyMigrationTimer);
    globalForWorker.__kortixLegacyMigrationTimer = null;
  }
}
