import { HeartbeatManager } from 'agent-tunnel';
import { config } from '../../lib/config';
import { tunnelRelay } from './relay';

export const heartbeatManager = new HeartbeatManager(tunnelRelay, {
  intervalMs: config.TUNNEL_HEARTBEAT_INTERVAL_MS,
  maxMissed: config.TUNNEL_HEARTBEAT_MAX_MISSED,
});
