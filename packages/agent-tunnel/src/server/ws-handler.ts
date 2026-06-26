import type { TunnelRelay } from './relay';
import type { HeartbeatManager } from './heartbeat';
import type { TunnelAuthMessage, AuthResult } from '../shared/types';

export interface WsHandlerOptions {
  heartbeat?: HeartbeatManager;
  maxMessageSize?: number;
  onAuthenticate?: (tunnelId: string, token: string) => Promise<AuthResult | null>;
  authTimeoutMs?: number;
}

export interface WsHandlers {
  onOpen(tunnelId: string, ws: WebSocket): void;
  onMessage(tunnelId: string, message: string | Buffer): void;
  onClose(tunnelId: string, ws?: WebSocket): void;
}

export function createWsHandlers(relay: TunnelRelay, opts?: WsHandlerOptions): WsHandlers {
  const maxMessageSize = opts?.maxMessageSize ?? 5 * 1024 * 1024;
  const heartbeat = opts?.heartbeat;
  const onAuthenticate = opts?.onAuthenticate;
  const authTimeoutMs = opts?.authTimeoutMs ?? 10_000;

  const pendingConnections = new Map<string, { ws: WebSocket; timer: ReturnType<typeof setTimeout> }>();

  return {
    onOpen(tunnelId: string, ws: WebSocket) {
      const timer = setTimeout(() => {
        pendingConnections.delete(tunnelId);
        try { ws.close(4001, 'auth timeout'); } catch {}
      }, authTimeoutMs);

      pendingConnections.set(tunnelId, { ws, timer });
    },

    async onMessage(tunnelId: string, message: string | Buffer) {
      const msgStr = typeof message === 'string' ? message : message.toString('utf-8');
      const msgSize = typeof message === 'string' ? message.length : (message as Buffer).byteLength;

      if (msgSize > maxMessageSize) {
        console.warn(`[tunnel-ws] Oversized message from ${tunnelId}: ${msgSize} bytes (limit: ${maxMessageSize})`);
        const pending = pendingConnections.get(tunnelId);
        const ws = pending?.ws;
        if (ws) {
          try { ws.close(4002, 'message too large'); } catch {}
        }
        return;
      }

      const pending = pendingConnections.get(tunnelId);
      if (pending) {
        let authMsg: TunnelAuthMessage;
        try {
          authMsg = JSON.parse(msgStr);
        } catch {
          try { pending.ws.close(4001, 'invalid auth message'); } catch {}
          clearTimeout(pending.timer);
          pendingConnections.delete(tunnelId);
          return;
        }

        if (authMsg.type !== 'auth' || !authMsg.token) {
          try { pending.ws.close(4001, 'expected auth message'); } catch {}
          clearTimeout(pending.timer);
          pendingConnections.delete(tunnelId);
          return;
        }

        clearTimeout(pending.timer);
        pendingConnections.delete(tunnelId);

        if (!onAuthenticate) {
          try { pending.ws.close(4001, 'no authenticator configured'); } catch {}
          return;
        }

        try {
          const result = await onAuthenticate(tunnelId, authMsg.token);
          if (!result) {
            try { pending.ws.close(4001, 'authentication failed'); } catch {}
            return;
          }

          // Send signing key to agent so it never needs the server secret
          try {
            pending.ws.send(JSON.stringify({ type: 'auth_ok', signingKey: result.signingKey }));
          } catch {}

          relay.registerAgent(tunnelId, pending.ws, result.signingKey, result.metadata);
          if (heartbeat) {
            heartbeat.register(tunnelId);
          }
        } catch (err) {
          console.error(`[tunnel-ws] Auth error for ${tunnelId}:`, err);
          try { pending.ws.close(4001, 'authentication error'); } catch {}
        }

        return;
      }

      relay.handleAgentMessage(tunnelId, message);
    },

    onClose(tunnelId: string, ws?: WebSocket) {
      const pending = pendingConnections.get(tunnelId);
      if (pending && (!ws || pending.ws === ws)) {
        clearTimeout(pending.timer);
        pendingConnections.delete(tunnelId);
        return;
      }

      const removed = relay.unregisterAgent(tunnelId, ws);
      if (removed && heartbeat) {
        heartbeat.unregister(tunnelId);
      }
    },
  };
}
