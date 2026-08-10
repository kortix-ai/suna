import type { TunnelRelay } from './relay';
import type { HeartbeatManager } from './heartbeat';
import type { TunnelAuthMessage, AuthResult } from '../shared/types';

export interface WsHandlerOptions {
  heartbeat?: HeartbeatManager;
  maxMessageSize?: number;
  onAuthenticate?: (
    tunnelId: string,
    token: string,
    auth: TunnelAuthMessage,
  ) => Promise<AuthResult | null>;
  authTimeoutMs?: number;
}

export interface WsHandlers {
  onOpen(tunnelId: string, ws: WebSocket): void;
  onMessage(tunnelId: string, ws: WebSocket, message: string | Buffer): void;
  onClose(tunnelId: string, ws?: WebSocket): void;
}

export function createWsHandlers(relay: TunnelRelay, opts?: WsHandlerOptions): WsHandlers {
  const maxMessageSize = opts?.maxMessageSize ?? 5 * 1024 * 1024;
  const heartbeat = opts?.heartbeat;
  const onAuthenticate = opts?.onAuthenticate;
  const authTimeoutMs = opts?.authTimeoutMs ?? 10_000;

  const pendingConnections = new Map<
    WebSocket,
    {
      tunnelId: string;
      timer: ReturnType<typeof setTimeout>;
      authenticating: boolean;
    }
  >();

  return {
    onOpen(tunnelId: string, ws: WebSocket) {
      const timer = setTimeout(() => {
        pendingConnections.delete(ws);
        try {
          ws.close(4001, 'auth timeout');
        } catch {}
      }, authTimeoutMs);

      pendingConnections.set(ws, { tunnelId, timer, authenticating: false });
    },

    async onMessage(tunnelId: string, ws: WebSocket, message: string | Buffer) {
      const msgStr = typeof message === 'string' ? message : message.toString('utf-8');
      const msgSize =
        typeof message === 'string'
          ? Buffer.byteLength(message, 'utf8')
          : (message as Buffer).byteLength;

      if (msgSize > maxMessageSize) {
        console.warn(
          `[tunnel-ws] Oversized message from ${tunnelId}: ${msgSize} bytes (limit: ${maxMessageSize})`,
        );
        try {
          ws.close(4002, 'message too large');
        } catch {}
        if (pendingConnections.has(ws)) {
          const pending = pendingConnections.get(ws);
          if (pending) clearTimeout(pending.timer);
          pendingConnections.delete(ws);
        }
        return;
      }

      const pending = pendingConnections.get(ws);
      if (pending) {
        if (pending.tunnelId !== tunnelId) {
          clearTimeout(pending.timer);
          pendingConnections.delete(ws);
          try {
            ws.close(4001, 'tunnel identity mismatch');
          } catch {}
          return;
        }
        if (pending.authenticating) return;
        let authMsg: TunnelAuthMessage;
        try {
          authMsg = JSON.parse(msgStr);
        } catch {
          try {
            ws.close(4001, 'invalid auth message');
          } catch {}
          clearTimeout(pending.timer);
          pendingConnections.delete(ws);
          return;
        }

        if (authMsg.type !== 'auth' || !authMsg.token) {
          try {
            ws.close(4001, 'expected auth message');
          } catch {}
          clearTimeout(pending.timer);
          pendingConnections.delete(ws);
          return;
        }

        if (!onAuthenticate) {
          clearTimeout(pending.timer);
          pendingConnections.delete(ws);
          try {
            ws.close(4001, 'no authenticator configured');
          } catch {}
          return;
        }

        pending.authenticating = true;
        try {
          const result = await onAuthenticate(tunnelId, authMsg.token, authMsg);
          if (pendingConnections.get(ws) !== pending || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          clearTimeout(pending.timer);
          pendingConnections.delete(ws);
          if (!result) {
            try {
              ws.close(4001, 'authentication failed');
            } catch {}
            return;
          }

          // Send signing key to agent so it never needs the server secret.
          // A socket that cannot receive the key must never become active.
          try {
            ws.send(
              JSON.stringify({
                type: 'auth_ok',
                signingKey: result.signingKey,
              }),
            );
          } catch {
            try {
              ws.close(4001, 'authentication response failed');
            } catch {}
            return;
          }

          relay.registerAgent(tunnelId, ws, result.signingKey, result.metadata);
          if (heartbeat) {
            heartbeat.register(tunnelId);
          }
        } catch (err) {
          clearTimeout(pending.timer);
          pendingConnections.delete(ws);
          console.error(`[tunnel-ws] Auth error for ${tunnelId}:`, err);
          try {
            ws.close(4001, 'authentication error');
          } catch {}
        }

        return;
      }

      relay.handleAgentMessage(tunnelId, ws, message);
    },

    onClose(tunnelId: string, ws?: WebSocket) {
      const pending = ws ? pendingConnections.get(ws) : undefined;
      if (pending) {
        clearTimeout(pending.timer);
        pendingConnections.delete(ws!);
        return;
      }

      const removed = relay.unregisterAgent(tunnelId, ws);
      if (removed && heartbeat) {
        heartbeat.unregister(tunnelId);
      }
    },
  };
}
