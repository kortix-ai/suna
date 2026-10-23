import { config } from '../config';
import { RETENTION_ERASURE_BATCH, processRetentionErasures } from '../billing/services/retention-erasure';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const IDLE_MS = 24 * 60 * 60_000;
const BACKLOG_MS = 60_000;

// Leader only, serial: the account retention backstop
// (billing/services/retention-erasure.ts). One pass a day; a full batch means a
// backlog, so the next pass comes a minute later. The first pass runs at start:
// a decided account is not selected again the same day, so a deploy repeats
// nothing. RETENTION_ERASURE_MODE=off stops it.
const worker = leaderTimer(async () => {
  if (config.RETENTION_ERASURE_MODE === 'off') return IDLE_MS;
  const result = await runWorkerTick('retention-erasure', () => processRetentionErasures());
  return result.selected >= RETENTION_ERASURE_BATCH ? BACKLOG_MS : IDLE_MS;
}, { name: 'retention-erasure' });

export const startRetentionErasureWorker = worker.start;
export const stopRetentionErasureWorker = worker.stop;
