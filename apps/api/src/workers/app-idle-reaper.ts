import { logger } from '../lib/logger';
import { runWorkerTick } from '../services/audit/audit-scope';
import { runAppIdleReaper } from '../services/apps/idle-reaper';

const state = globalThis as unknown as {
  __kortixAppsIdleTimer?: ReturnType<typeof setInterval> | null;
};

export function startAppIdleReaper(): void {
  if (process.env.KORTIX_APPS_IDLE_REAPER_ENABLED === 'false') return;
  stopAppIdleReaper();
  const interval = Math.max(5_000, Number(process.env.KORTIX_APPS_IDLE_REAPER_INTERVAL_MS) || 30_000);
  state.__kortixAppsIdleTimer = setInterval(() => {
    void runWorkerTick('app-idle-reaper', runAppIdleReaper).catch((error) => logger.error('[apps] idle reaper failed', {
      error: error instanceof Error ? error.message : String(error),
    }));
  }, interval);
}

export function stopAppIdleReaper(): void {
  if (state.__kortixAppsIdleTimer) {
    clearInterval(state.__kortixAppsIdleTimer);
    state.__kortixAppsIdleTimer = null;
  }
}
