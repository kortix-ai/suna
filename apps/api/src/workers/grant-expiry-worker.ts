import { runGrantExpirySweepOnce } from '../iam/expiry-sweeper';
import { leaderTimer } from '../shared/leader-timer';
import { runWorkerTick } from '../shared/audit-scope';

const TICK_MS = 60_000;

// Serial ticks (a tick that outlasts TICK_MS must not overlap the next one: two
// ticks racing inside one process wrote duplicate audit rows) and one chain per
// leadership term — see shared/leader-timer.ts. Fires once on start, so an
// expiry that happened during downtime is logged at once.
const sweeper = leaderTimer(async () => {
  try {
    await runWorkerTick('iam-grant-expiry', runGrantExpirySweepOnce);
  } catch (err) {
    console.error('[iam expiry sweeper] tick failed', err);
  }
  return TICK_MS;
});

export const startGrantExpirySweeper = sweeper.start;
export const stopGrantExpirySweeper = sweeper.stop;
