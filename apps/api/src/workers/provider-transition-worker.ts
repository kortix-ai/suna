import { logger } from '../lib/logger';
import { runProviderTransitionTick } from '../projects/provider-transition/provider-transition-worker';
import { runWorkerTick } from '../shared/audit-scope';

type Timer = ReturnType<typeof setInterval>;
const g = globalThis as unknown as { __kortixProviderTransitionTimer?: Timer | null };
let timer: Timer | null = null;
let running = false;

function intervalMs(): number {
  const raw = Number(process.env.KORTIX_PROVIDER_TRANSITION_WORKER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

export function startProviderTransitionWorker(): void {
  if (process.env.KORTIX_PROVIDER_TRANSITION_WORKER_ENABLED === 'false') return;
  if (g.__kortixProviderTransitionTimer) clearInterval(g.__kortixProviderTransitionTimer);
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runWorkerTick('provider-transition', runProviderTransitionTick)
      .catch((err) =>
        logger.error('[provider-transition-worker] tick failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => {
        running = false;
      });
  }, intervalMs());
  g.__kortixProviderTransitionTimer = timer;
}

export function stopProviderTransitionWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (g.__kortixProviderTransitionTimer) {
    clearInterval(g.__kortixProviderTransitionTimer);
    g.__kortixProviderTransitionTimer = null;
  }
}
