import { config } from '../config';
import { runWorkerTick } from '../shared/audit-scope';
import { startTunnelRpcForwarder, stopTunnelRpcForwarder } from '../tunnel/core/cluster-forwarder';
import { heartbeatManager } from '../tunnel/core/heartbeat';
import { tunnelRelay } from '../tunnel/core/relay';
import { runTunnelCleanupOnce } from '../tunnel/registrations';
import { registerTunnelRelayPersistence } from '../tunnel/relay-persistence';

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startTunnelService(): void {
  if (!config.TUNNEL_ENABLED) {
    console.log('[TUNNEL] Tunnel disabled (TUNNEL_ENABLED=false)');
    return;
  }

  heartbeatManager.start();
  startTunnelRpcForwarder();

  registerTunnelRelayPersistence();

  // ── Rate-limiter + device-auth cleanup ───────────────────────────────

  cleanupInterval = setInterval(() => void runWorkerTick('tunnel-cleanup', runTunnelCleanupOnce), 5 * 60_000);

  console.log('[TUNNEL] Tunnel service started');
}

export function stopTunnelService(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  stopTunnelRpcForwarder();
  heartbeatManager.stop();
  tunnelRelay.shutdown();
  console.log('[TUNNEL] Tunnel service stopped');
}
