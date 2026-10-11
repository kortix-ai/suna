// Serial daily audit archive, one chain per leadership term (shared/leader-timer.ts).
import { config } from '../config';
import { runAuditArchiveOnce } from '../shared/audit-archive/worker';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const TICK_MS = 24 * 3_600_000;
const FIRST_TICK_MS = 10 * 60_000;

const worker = leaderTimer(
  async () => {
    try {
      const outcome = await runWorkerTick('audit-archive', runAuditArchiveOnce);
      if (outcome?.ran) console.info('[audit archive] pass finished', outcome);
      else if (outcome && config.AUDIT_ARCHIVE_ENABLED) console.warn('[audit archive] skipped:', outcome.reason);
    } catch (err) {
      console.error('[audit archive] pass failed', err);
    }
    return TICK_MS;
  },
  { firstDelayMs: FIRST_TICK_MS },
);

export const startAuditArchiveWorker = worker.start;
export const stopAuditArchiveWorker = worker.stop;
