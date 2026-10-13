import { config } from '../config';
import { backfillSessionLogs, newBackfillState } from '../projects/surface';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const IDLE_MS = 60 * 60_000;
const BACKLOG_MS = 5_000;

// replica-local: this leader's pass cursor and running totals. A new leader starts a new pass;
// written logs have left the queue, so it only re-reads what a dry pass or a failure left.
const state = newBackfillState();

// Leader only, serial: old sessions into the session log (P3.1). Every 5 s while the queue
// holds more, hourly once a pass ends. SESSION_LOG_BACKFILL=off (default) runs nothing.
const worker = leaderTimer(async () => {
  const mode = config.SESSION_LOG_BACKFILL;
  if (mode === 'off') return IDLE_MS;
  const tick = await runWorkerTick('session-log-backfill', () => backfillSessionLogs(mode, state));
  return tick.more ? BACKLOG_MS : IDLE_MS;
});

export const startSessionLogBackfillWorker = worker.start;
export const stopSessionLogBackfillWorker = worker.stop;
