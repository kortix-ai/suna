import { markApprovalCardDecided } from '../channels/approval-card-relay';
import { sweepHeldCalls } from '../connectors/held-call-run';
import { logger } from '../lib/logger';
import { expireDueApprovals } from '../projects/surface';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const TICK_MS = 60_000;

/**
 * One sweep: close every pending approval past `expires_at` and replace its
 * chat card, then settle stuck held runs and wipe held input older than 31 days.
 */
export async function runApprovalExpiryTick(): Promise<number> {
  const expired = await expireDueApprovals((projectId, row) =>
    markApprovalCardDecided({ projectId, row, decision: 'expired', note: '', actorUserId: '' }),
  );
  return expired + (await sweepHeldCalls());
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
