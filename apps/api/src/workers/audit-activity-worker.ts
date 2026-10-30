import { logger } from '../lib/logger';
import { rollupNextAuditActivitySlice } from '../shared/audit-activity';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const IDLE_MS = 5 * 60_000;
const BACKLOG_MS = 1_000;
const RETRY_MS = 60_000;

// Leader only, serial: add one closed 15-minute slice of audit events to
// audit_activity_daily per tick. Every second while behind (the first run backfills
// 90 days), every 5 minutes once caught up.
const worker = leaderTimer(async () => {
  try {
    const rolled = await runWorkerTick('audit-activity', rollupNextAuditActivitySlice);
    return rolled ? BACKLOG_MS : IDLE_MS;
  } catch (err) {
    logger.error('[audit activity] tick failed', { error: String(err) });
    return RETRY_MS;
  }
}, { name: 'audit-activity' });

export const startAuditActivityWorker = worker.start;
export const stopAuditActivityWorker = worker.stop;
