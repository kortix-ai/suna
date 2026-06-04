/**
 * Standalone tunnel server — one function call to get a working relay.
 *
 * Usage:
 *   import { startTunnelServer } from 'agent-tunnel';
 *   const server = startTunnelServer({ port: 8080, onAuthenticate: ... });
 *
 * Agents connect via: ws://localhost:8080/ws?tunnelId=yyy
 * Then send { type: "auth", token: "tnl_xxx" } as the first message.
 * Your app calls relay.relayRPC(tunnelId, method, params) to reach the agent.
 */

import { Hono } from 'hono';
import { TunnelRelay } from './relay';
import { HeartbeatManager } from './heartbeat';
import { createTunnelRouter } from './routes';
import { createWsHandlers } from './ws-handler';
import type { TunnelServerConfig } from '../shared/types';

export interface TunnelServer {
  app: Hono;
  relay: TunnelRelay;
  heartbeat: HeartbeatManager;
  wsHandlers: ReturnType<typeof createWsHandlers>;
  stop: () => void;
}

/**
 * Start a tunnel relay server. Handles everything:
 * - HTTP routes for connections list + RPC
 * - WebSocket upgrades on /ws for agent connections
 * - Heartbeat ping/pong
 * - HMAC signing key derivation via onAuthenticate hook
 *
 * Requires Bun runtime for WebSocket server support.
 */
export function startTunnelServer(config?: TunnelServerConfig): TunnelServer {
  const port = config?.port ?? parseInt(process.env.PORT || '8080', 10);

  const relay = new TunnelRelay(config?.relay);

  if (config?.onAuthorizeRPC) {
    relay.onAuthorizeRPC = config.onAuthorizeRPC;
  }

  const heartbeat = new HeartbeatManager(relay, config?.heartbeat);
  const wsHandlers = createWsHandlers(relay, {
    heartbeat,
    onAuthenticate: config?.onAuthenticate,
  });

  const app = new Hono();

  const tunnelRouter = createTunnelRouter(relay, config?.onAuthorizeHTTP);
  app.route('/', tunnelRouter);

  app.get('/health', (c) => c.json({ status: 'ok', connections: relay.getConnectedCount() }));

  relay.on('message:pong', (data: { tunnelId: string }) => {
    heartbeat.recordPong(data.tunnelId);
  });

  heartbeat.start();

  const bunServer = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === '/ws') {
        const tunnelId = url.searchParams.get('tunnelId');

        if (!tunnelId) {
          return new Response(JSON.stringify({ error: 'Missing tunnelId' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const success = server.upgrade(req, {
          data: { tunnelId } as any,
        });
        if (success) return undefined;

        return new Response('WebSocket upgrade failed', { status: 500 });
      }

      return app.fetch(req);
    },

    websocket: {
      idleTimeout: 0,
      open(ws: any) {
        wsHandlers.onOpen(ws.data.tunnelId, ws);
      },
      message(ws: any, message: string | Buffer) {
        wsHandlers.onMessage(ws.data.tunnelId, message);
      },
      close(ws: any) {
        wsHandlers.onClose(ws.data.tunnelId);
      },
    },
  });

  console.log(`[agent-tunnel] Server listening on port ${port}`);

  const stop = () => {
    heartbeat.stop();
    relay.shutdown();
    bunServer.stop();
  };

  return { app, relay, heartbeat, wsHandlers, stop };
}
