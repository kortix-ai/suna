import { logger } from '../../lib/logger';
import { runGoalReconcilerTick } from '../../projects/surface';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

/** Every 60 s, at most 50 goals per tick (projects/goals/reconcile.ts). */
const TICK_MS = 60_000;

// Where the pass stopped. Leader memory only: a new leader starts the pass
// over, which repeats checks that change nothing on a healthy goal.
let cursor: string | null = null;

// Serial ticks, one chain per leadership term (shared/leader-timer.ts). The
// interval is fixed: the tick never shortens it, whatever is pending.
const reconciler = leaderTimer(async () => {
  try {
    await runWorkerTick('goal-reconciler', async () => {
      const result = await runGoalReconcilerTick(cursor);
      cursor = result.cursor;
      if (result.setup || result.repaired || result.unblocked || result.ownerLost || result.stalled) {
        logger.info('[goals] reconcile tick', { ...result });
      }
      return result.checked;
    });
  } catch (err) {
    logger.error('[goals] reconcile tick failed', { error: String(err) });
  }
  return TICK_MS;
});

export const startGoalReconciler = reconciler.start;
export const stopGoalReconciler = reconciler.stop;
