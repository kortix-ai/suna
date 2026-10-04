/**
 * Resume loop for durable Suna account migrations — the durability guarantee.
 * Mirrors legacy-migration-worker: each tick finds live rows whose lease went
 * stale (crashed worker / released after a retryable failure) and re-drives
 * them. driveSunaMigration re-acquires the lease, so concurrent ticks are safe.
 * Runs only on the leader instance; the timer is in workers/suna-migration.ts.
 */
import { and, inArray, isNull, lt, or } from 'drizzle-orm';
import { sunaAccountMigrations } from '@kortix/db';
import { db } from '../../../lib/db';
import { logger as appLogger } from '../../../lib/logger';
import { driveSunaMigration, LEASE_TTL_MS } from './suna-migration-runner';

let running = false;

function batchSize(): number {
  const raw = Number(process.env.KORTIX_SUNA_MIGRATION_WORKER_BATCH);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/** One pass: re-drive up to a batch of stale migrations. Skips while a pass is in flight. */
export async function runSunaMigrationTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const staleBefore = new Date(Date.now() - LEASE_TTL_MS);
    const candidates = await db
      .select({ migrationId: sunaAccountMigrations.migrationId })
      .from(sunaAccountMigrations)
      .where(and(
        inArray(sunaAccountMigrations.status, ['planned', 'running']),
        or(isNull(sunaAccountMigrations.heartbeatAt), lt(sunaAccountMigrations.heartbeatAt, staleBefore)),
      ))
      .limit(batchSize());

    for (const { migrationId } of candidates) {
      try {
        await driveSunaMigration(db, migrationId);
      } catch (err) {
        appLogger.error('[suna-migration-worker] drive failed', { migrationId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (candidates.length > 0) appLogger.info('[suna-migration-worker] re-drove stale migrations', { count: candidates.length });
  } finally {
    running = false;
  }
}
