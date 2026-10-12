import { runNotificationDigestTick, sweepExpiredNotifications } from '../notifications/digest';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const TICK_MS = 60_000;

// Leader only, serial: the notification inbox's 90-day retention sweep, then
// the email digest of unread rows (KRTX-1742). leaderTimer logs a failed tick.
const worker = leaderTimer(async () => {
  await runWorkerTick('notification-digest', async () => {
    await sweepExpiredNotifications();
    await runNotificationDigestTick();
  });
  return TICK_MS;
});

export const startNotificationWorker = worker.start;
export const stopNotificationWorker = worker.stop;
