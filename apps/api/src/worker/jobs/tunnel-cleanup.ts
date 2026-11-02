// Serial 5-minute sweep of silent unidentified tunnel registrations and
// expired device auth requests, one chain per leadership term
// (shared/leader-timer.ts). Every API process ran it until the worker split;
// it touches every row, so one process is enough.

import { config } from '../../config';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';
import { runTunnelRegistrationCleanup } from '../../tunnel/registrations';

const TICK_MS = 5 * 60_000;

const sweeper = leaderTimer(
  async () => {
    await runWorkerTick('tunnel-cleanup', runTunnelRegistrationCleanup);
    return TICK_MS;
  },
  { firstDelayMs: TICK_MS, name: 'tunnel-cleanup' },
);

export function startTunnelCleanup(): void {
  if (config.TUNNEL_ENABLED) sweeper.start();
}

export const stopTunnelCleanup = sweeper.stop;
