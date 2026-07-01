import type { Effect } from 'effect';
import { TunnelRelay } from 'agent-tunnel';
import { sharedConfig as config } from '../../shared/effect';

export const tunnelRelay = new TunnelRelay({
  rpcTimeoutMs: config.TUNNEL_RPC_TIMEOUT_MS,
  maxWsMessageSize: config.TUNNEL_MAX_WS_MESSAGE_SIZE,
});
