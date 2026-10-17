import { config } from '../config';
import { PURGE_BATCH_SIZE, purgeSessionContent } from '../projects/surface';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const IDLE_MS = 60 * 60_000;
const BACKLOG_MS = 5_000;

// Leader only, serial: the retention purge of session content (P2.8, decision D6).
// One pass an hour is enough for 30-, 80- and 7-day windows. A full batch means a
// backlog (the first pass after a deploy meets every old deleted session), so the
// next pass comes in seconds. SESSION_LOG_PURGE_ENABLED=false stops it.
const worker = leaderTimer(async () => {
  if (!config.SESSION_LOG_PURGE_ENABLED) return IDLE_MS;
  const result = await runWorkerTick('session-log-purge', () => purgeSessionContent());
  return result.sessions >= PURGE_BATCH_SIZE || result.objects >= PURGE_BATCH_SIZE ? BACKLOG_MS : IDLE_MS;
});

export const startSessionLogPurgeWorker = worker.start;
export const stopSessionLogPurgeWorker = worker.stop;
