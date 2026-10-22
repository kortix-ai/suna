import { runAppIdleReaper, runAppKeepAlive } from '../apps/idle-reaper';
import { logger } from '../lib/logger';
import { runWorkerTick } from '../shared/audit-scope';

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
    // Its own guard and its own 5-minute cadence: a slow always-on start never
    // holds up an idle stop.
    void runWorkerTick('app-keep-alive', () => runAppKeepAlive()).catch((error) => logger.error('[apps] keep-alive pass failed', {
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
