import { config } from '../config';
import { startTunnelRpcForwarder, stopTunnelRpcForwarder } from '../tunnel/core/cluster-forwarder';
import { heartbeatManager } from '../tunnel/core/heartbeat';
import { tunnelRateLimiter } from '../tunnel/core/rate-limiter';
import { tunnelRelay } from '../tunnel/core/relay';
import { registerTunnelRelayPersistence } from '../tunnel/relay-persistence';

const RATE_LIMIT_SWEEP_MS = 5 * 60_000;

let rateLimitSweep: ReturnType<typeof setInterval> | null = null;

/**
 * The tunnel on one API process: agent heartbeats, the RPC forwarder for the
 * agents connected here, relay persistence, and this process's in-memory
 * rate-limit buckets. The database-wide sweeps are scheduled jobs:
 * `worker/jobs/tunnel-cleanup.ts` and `worker/jobs/tunnel-forward-expiry.ts`.
 */
export function startTunnelService(): void {
  if (!config.TUNNEL_ENABLED) {
    console.log('[TUNNEL] Tunnel disabled (TUNNEL_ENABLED=false)');
    return;
  }

  heartbeatManager.start();
  startTunnelRpcForwarder();
  registerTunnelRelayPersistence();
  rateLimitSweep ??= setInterval(() => tunnelRateLimiter.cleanup(), RATE_LIMIT_SWEEP_MS);

  console.log('[TUNNEL] Tunnel service started');
}

export function stopTunnelService(): void {
  if (rateLimitSweep) {
    clearInterval(rateLimitSweep);
    rateLimitSweep = null;
  }
  stopTunnelRpcForwarder();
  heartbeatManager.stop();
  tunnelRelay.shutdown();
  console.log('[TUNNEL] Tunnel service stopped');
}
