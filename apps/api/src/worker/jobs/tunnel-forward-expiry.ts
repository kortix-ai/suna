// Serial 30-second sweep of tunnel RPC forward rows past their relay window,
// one chain per leadership term (shared/leader-timer.ts). Every API process
// ran it inside its forwarder tick until the worker split; it deletes across
// every process's rows, so one process is enough.

import { config } from '../../config';
import { logger } from '../../lib/logger';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';
import { sweepExpiredTunnelForwards } from '../../tunnel/core/cluster-forwarder';

const TICK_MS = 30_000;

const sweeper = leaderTimer(
  async () => {
    try {
      await runWorkerTick('tunnel-forward-expiry', sweepExpiredTunnelForwards);
    } catch (err) {
      logger.warn('[tunnel-forwarder] expiry sweep failed', { error: err instanceof Error ? err.message : String(err) });
    }
    return TICK_MS;
  },
  { name: 'tunnel-forward-expiry' },
);

export function startTunnelForwardExpiry(): void {
  if (config.TUNNEL_ENABLED) sweeper.start();
}

export const stopTunnelForwardExpiry = sweeper.stop;
