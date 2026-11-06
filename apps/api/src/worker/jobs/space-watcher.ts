import { logger } from '../../lib/logger';
import { runSpaceWatcherTick } from '../../projects/surface';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

/** Every 2 minutes; a space wakes at most once per 10 minutes (projects/lib/space-watch/policy.ts). */
const TICK_MS = 2 * 60_000;

// Serial ticks, one chain per leadership term (shared/leader-timer.ts). The
// interval is fixed: the tick never shortens it, whatever is pending.
const watcher = leaderTimer(async () => {
  try {
    await runWorkerTick('space-watcher', async () => {
      const result = await runSpaceWatcherTick();
      if (result.woken > 0 || result.overdue > 0) logger.info('[space-watch] tick', { ...result });
      return result.woken;
    });
  } catch (err) {
    logger.error('[space-watch] tick failed', { error: String(err) });
  }
  return TICK_MS;
});

export const startSpaceWatcher = watcher.start;
export const stopSpaceWatcher = watcher.stop;
