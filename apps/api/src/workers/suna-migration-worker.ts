import { logger as appLogger } from '../lib/logger';
import { runSunaMigrationTick } from '../projects/suna-migration/suna-migration-worker';
import { runWorkerTick } from '../shared/audit-scope';

type Timer = ReturnType<typeof setInterval>;
const g = globalThis as unknown as { __kortixSunaMigrationTimer?: Timer | null };
let timer: Timer | null = null;

function intervalMs(): number {
  const raw = Number(process.env.KORTIX_SUNA_MIGRATION_WORKER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

export function startSunaMigrationWorker(): void {
  if (process.env.KORTIX_SUNA_MIGRATION_WORKER_ENABLED === 'false') return;
  if (g.__kortixSunaMigrationTimer) clearInterval(g.__kortixSunaMigrationTimer);
  timer = setInterval(() => {
    runWorkerTick('suna-migration', runSunaMigrationTick).catch((err) => appLogger.error('[suna-migration-worker] tick failed', { error: err instanceof Error ? err.message : String(err) }));
  }, intervalMs());
  g.__kortixSunaMigrationTimer = timer;
}

export function stopSunaMigrationWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (g.__kortixSunaMigrationTimer) { clearInterval(g.__kortixSunaMigrationTimer); g.__kortixSunaMigrationTimer = null; }
}
