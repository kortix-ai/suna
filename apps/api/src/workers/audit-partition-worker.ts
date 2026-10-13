// The leader's audit partition tick (shared/audit-partition-worker.ts).
// Serial, one chain per leadership term (shared/leader-timer.ts).
import { runWorkerTick } from '../shared/audit-scope';
import { ensureAuditPartitions } from '../shared/audit-partition-worker';
import { leaderTimer } from '../shared/leader-timer';

const TICK_MS = 6 * 60 * 60_000;
// A failed tick (a lock timeout behind a long statement) retries soon: 8 weeks of runway means no
// urgency, but nothing should wait a whole tick for a transient failure.
const RETRY_MS = 5 * 60_000;

const worker = leaderTimer(async () => {
  try {
    const result = await runWorkerTick('audit-partitions', () => ensureAuditPartitions());
    if (result?.created) console.info('[audit partitions] created', result.created, 'weekly partition(s)');
    if (result?.defaultPartitionHasRows) {
      console.warn('[audit partitions] kortix.audit_events_default holds rows: an instant had no weekly partition');
    }
    return TICK_MS;
  } catch (err) {
    console.error('[audit partitions] tick failed', err);
    return RETRY_MS;
  }
});

export const startAuditPartitionWorker = worker.start;
export const stopAuditPartitionWorker = worker.stop;
