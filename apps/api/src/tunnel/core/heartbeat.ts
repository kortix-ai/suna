import { HeartbeatManager } from 'agent-tunnel';
import { sharedConfig as config } from '../../shared/effect';
import { tunnelRelay } from './relay';

export const heartbeatManager = new HeartbeatManager(tunnelRelay, {
  intervalMs: config.TUNNEL_HEARTBEAT_INTERVAL_MS,
  maxMissed: config.TUNNEL_HEARTBEAT_MAX_MISSED,
});
