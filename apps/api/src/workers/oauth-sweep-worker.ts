// Serial hourly OAuth sweep, one chain per leadership term (shared/leader-timer.ts).

import { runOAuthSweepOnce } from '../oauth/sweeper';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const TICK_MS = 60 * 60_000;

const sweeper = leaderTimer(async () => {
  try {
    const swept = await runWorkerTick('oauth-sweep', runOAuthSweepOnce);
    if (swept && (swept.requests || swept.clients)) console.info('[oauth sweep] deleted', swept);
  } catch (err) {
    console.error('[oauth sweep] tick failed', err);
  }
  return TICK_MS;
});

export const startOAuthSweeper = sweeper.start;
export const stopOAuthSweeper = sweeper.stop;
