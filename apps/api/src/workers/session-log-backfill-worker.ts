import { config } from '../config';
import { backfillSessionLogs } from '../projects/surface';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const IDLE_MS = 60 * 60_000;
const BACKLOG_MS = 5_000;

// Leader only, serial: old sessions into the session log (P3.1). Every 5 s while the queue
// holds more, hourly once a pass ends. The pass state is a DB row, so a new leader resumes it.
// `write` starts a new pass each hour (it retries the failures; an empty queue costs one
// selection). `dry` runs one pass, then each hourly tick does nothing until the mode changes.
// SESSION_LOG_BACKFILL=off (default) runs nothing.
const worker = leaderTimer(async () => {
  const mode = config.SESSION_LOG_BACKFILL;
  if (mode === 'off') return IDLE_MS;
  const tick = await runWorkerTick('session-log-backfill', () => backfillSessionLogs(mode));
  return tick.more ? BACKLOG_MS : IDLE_MS;
});

export const startSessionLogBackfillWorker = worker.start;
export const stopSessionLogBackfillWorker = worker.stop;
