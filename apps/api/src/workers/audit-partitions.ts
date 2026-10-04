// The leader's audit partition tick (see services/audit/audit-partition-worker.ts).
// Recursive setTimeout keeps ticks serial per process.
import { runWorkerTick } from '../services/audit/audit-scope';
import { ensureAuditPartitions } from '../services/audit/audit-partition-worker';

const TICK_MS = 6 * 60 * 60_000;
// A failed tick (a lock timeout behind a long statement) retries soon: 8 weeks of runway means no
// urgency, but nothing should wait a whole tick for a transient failure.
const RETRY_MS = 5 * 60_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

async function tickAndRearm(): Promise<void> {
  let delay = TICK_MS;
  try {
    const result = await runWorkerTick('audit-partitions', () => ensureAuditPartitions());
    if (result?.created) console.info('[audit partitions] created', result.created, 'weekly partition(s)');
    if (result?.defaultPartitionHasRows) {
      console.warn('[audit partitions] kortix.audit_events_default holds rows: an instant had no weekly partition');
    }
  } catch (err) {
    delay = RETRY_MS;
    console.error('[audit partitions] tick failed', err);
  }
  if (!stopped) timer = setTimeout(tickAndRearm, delay);
}

export function startAuditPartitionWorker(): void {
  if (timer) return;
  stopped = false;
  void tickAndRearm();
}

export function stopAuditPartitionWorker(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
