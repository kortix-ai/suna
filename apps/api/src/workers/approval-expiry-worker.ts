import { markApprovalCardDecided } from '../channels/approval-card-relay';
import { logger } from '../lib/logger';
import { expireDueApprovals } from '../projects/surface';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const TICK_MS = 60_000;

/** One sweep: close every pending approval past `expires_at` and replace its chat card. */
export function runApprovalExpiryTick(): Promise<number> {
  return expireDueApprovals((projectId, row) =>
    markApprovalCardDecided({ projectId, row, decision: 'expired', note: '', actorUserId: '' }),
  );
}

// Serial ticks, one chain per leadership term (shared/leader-timer.ts). Fires
// once on start, so approvals that expired during downtime close at once.
const sweeper = leaderTimer(async () => {
  try {
    await runWorkerTick('approval-expiry', runApprovalExpiryTick);
  } catch (err) {
    logger.error('[approval expiry] tick failed', { error: String(err) });
  }
  return TICK_MS;
});

export const startApprovalExpirySweeper = sweeper.start;
export const stopApprovalExpirySweeper = sweeper.stop;
