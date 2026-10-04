import { config } from '../lib/config';
import { runWorkerTick } from '../services/audit/audit-scope';
import { startTunnelRpcForwarder, stopTunnelRpcForwarder } from '../services/tunnel/core/cluster-forwarder';
import { heartbeatManager } from '../services/tunnel/core/heartbeat';
import { tunnelRelay } from '../services/tunnel/core/relay';
import { runTunnelCleanupOnce } from '../services/tunnel/registrations';
import { registerTunnelRelayPersistence } from '../services/tunnel/relay-persistence';

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
