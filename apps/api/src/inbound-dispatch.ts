import { config } from './config';
import { getRequestUrl } from './lib/request-url';
import { runInboundAudit } from './shared/audit-edge';
import { annotateAuditEvent, setInboundAuditEntrypoint } from './shared/audit-scope';
import { resolveAppRequest, handleAppPublicRequest } from './apps/public-proxy';
import { prepareAppWsUpgrade } from './apps/ws-proxy';
import { handlePreviewOriginRequest, isPreviewHost } from './sandbox-proxy/preview-origin';
import { matchPreviewWsPath, preparePreviewHostWsUpgrade, preparePreviewWsUpgrade } from './sandbox-proxy/ws-proxy';
import { isUuid } from './shared/validate';

const SECRET_RELAY_PATH = /^\/v1\/projects\/[^/]+\/secrets\/[^/]+\/relay(?:\/|$)/;

export type InboundServer = {
  timeout(req: Request, seconds: number): void;
  upgrade(req: Request, options: { data: any }): boolean;
};

export function createInboundDispatch(app: { fetch(req: Request, server: any): Response | Promise<Response> }, isSchemaReady: () => boolean) {
/**
 * Route one inbound request. Everything here runs inside the audit boundary
 * (`runInboundAudit`, called from `fetch` below): each branch that answers
 * outside Hono names its entrypoint class so its row says what it was.
 * `unit-audit-boundary-wiring.test.ts` fails if a branch escapes it.
 */
// MCP tool calls (./mcp) re-enter the API as ordinary requests: through the
// audit boundary and this dispatcher, never around them. There is no socket,
// so nothing to time out and nothing to upgrade.
const IN_PROCESS_SERVER = { timeout() {}, upgrade: () => false };
async function dispatchInProcess(req: Request): Promise<Response> {
  const url = getRequestUrl(req, config.PORT);
  const response = await runInboundAudit(req, url, () => dispatchInbound(req, url, IN_PROCESS_SERVER));
  return response ?? new Response(null, { status: 500 });
}

async function dispatchInbound(
  req: Request,
  url: URL,
  server: InboundServer,
): Promise<Response | undefined> {
  const isWsUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket';

  // Sandbox preview traffic includes OpenCode long-poll and SSE routes. Let
  // the proxy's own upstream timeout decide instead of Bun closing the client
  // socket early with an empty reply.
  if (url.pathname.includes('/v1/p/')) {
    server.timeout(req, 0);
  }

  // The secret streaming relay carries SSE and long-lived upstream bodies.
  // Without this Bun cuts the socket with an empty reply that the LB turns
  // into a 502 with no CORS headers — the same shape as the gateway
  // idleTimeout incident. The global `idleTimeout: 0` above is necessary but
  // not sufficient: `server.timeout(req, …)` is the PER-REQUEST budget.
  if (SECRET_RELAY_PATH.test(url.pathname)) {
    server.timeout(req, 0);
  }

  // The standalone-gateway reverse proxy streams chat completions (SSE). Let
  // the gateway's own keep-alive / upstream timeout govern it instead of Bun
  // closing the client socket at idleTimeout with an empty reply.
  // Covers BOTH the internal `/v1/llm-gateway` prefix used by cloud sandboxes
  // and `/v1/llm`, the documented public path — which was unguarded.
  if (url.pathname.startsWith('/v1/llm')) {
    server.timeout(req, 0);
  }

  // ── Subdomain preview routing ──────────────────────────────────────
  // Matches `p{port}-{sandboxId}.localhost:{apiPort}` regardless of path.
  // Same per-request long-poll/SSE timeout posture as /v1/p/.
  if (resolveAppRequest(req, url)) {
    server.timeout(req, 0);
    if (isWsUpgrade) {
      setInboundAuditEntrypoint('app_origin', 'app_origin:websocket');
      const prepared = await prepareAppWsUpgrade(req, url);
      if (!prepared.ok) {
        return new Response(JSON.stringify({ error: prepared.message }), {
          status: prepared.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const upgraded = server.upgrade(req, { data: prepared.data });
      if (upgraded) return undefined;
      return new Response(JSON.stringify({ error: 'App WebSocket upgrade failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const appResponse = await handleAppPublicRequest(req);
    if (appResponse) {
      setInboundAuditEntrypoint('app_origin', 'app_origin');
      return appResponse;
    }
  }
  if (isPreviewHost(req, url)) {
    server.timeout(req, 0);
    // An app on its own origin opens `new WebSocket('/hmr')` — dev-server
    // hot reload, live preview, anything socket-driven. The handshake is an
    // ordinary HTTP request, so it carries the preview cookie and needs no
    // token in the URL.
    if (isWsUpgrade) {
      setInboundAuditEntrypoint('preview_origin', 'preview_origin:websocket');
      const prepared = await preparePreviewHostWsUpgrade(req, url);
      if (!prepared.ok) {
        return new Response(JSON.stringify({ error: prepared.message }), {
          status: prepared.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (server.upgrade(req, { data: prepared.data })) return undefined;
      return new Response(JSON.stringify({ error: 'Preview WebSocket upgrade failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const res = await handlePreviewOriginRequest(req, url);
    if (res) {
      setInboundAuditEntrypoint('preview_origin', 'preview_origin');
      return res;
    }
  }

  // ── Tunnel Agent WebSocket ──────────────────────────────────────────
  // Agent connects, then authenticates via first message (auth handshake).
  // Token is never sent in URL — only tunnelId is in the query string.
  if (isWsUpgrade && url.pathname === '/v1/tunnel/ws') {
    setInboundAuditEntrypoint('ws_upgrade', 'ws:/v1/tunnel/ws');
    if (!isSchemaReady()) {
      return new Response(JSON.stringify({ error: 'Service starting up, try again shortly' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
      });
    }

    const tunnelId = url.searchParams.get('tunnelId');

    if (!isUuid(tunnelId)) {
      return new Response(JSON.stringify({ error: 'A valid tunnelId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Agent Tunnel is a native CLI protocol. Browsers always send Origin on
    // WebSocket upgrades; rejecting it prevents cross-site WebSocket use if
    // a machine bearer is ever exposed to browser-accessible state.
    if (req.headers.has('origin')) {
      return new Response(
        JSON.stringify({
          error: 'Browser tunnel WebSockets are not allowed',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // Include the source address so an unauthenticated attacker who learns a
    // tunnelId cannot consume the real machine's reconnect budget.
    const { tunnelRateLimiter } = await import('./tunnel/core/rate-limiter');
    const { clientKeyFromHeaders } = await import('./shared/client-ip');
    const clientIp = clientKeyFromHeaders((name) => req.headers.get(name));
    const wsIpRateCheck = tunnelRateLimiter.check('wsConnectIp', clientIp);
    if (!wsIpRateCheck.allowed) {
      return new Response(
        JSON.stringify({
          error: 'Too many connection attempts',
          retryAfterMs: wsIpRateCheck.retryAfterMs,
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const wsRateCheck = tunnelRateLimiter.check('wsConnect', `${clientIp}:${tunnelId}`);
    if (!wsRateCheck.allowed) {
      return new Response(
        JSON.stringify({
          error: 'Too many connection attempts',
          retryAfterMs: wsRateCheck.retryAfterMs,
        }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // The upgrade carries only the tunnel id; the machine's token arrives in

    // its first message and is audited by the tunnel's own authenticator.

    annotateAuditEvent({ resourceType: 'tunnel', resourceId: tunnelId });

    const success = server.upgrade(req, {
      data: {
        type: 'tunnel-agent',
        tunnelId,
      },
    });
    if (success) return undefined;
  }

  // ── Preview WebSocket proxy ─────────────────────────────────────────
  // Path-based preview upgrades (`/v1/p/{sandboxId}/{port}/...`) — today the
  // xterm PTY terminal. Authenticate via the `?token=` query param (browsers
  // can't set WS headers), resolve the sandbox upstream, then upgrade and
  // pipe bytes. See sandbox-proxy/ws-proxy.ts.
  if (isWsUpgrade && matchPreviewWsPath(url.pathname)) {
    setInboundAuditEntrypoint('ws_upgrade', 'ws:/v1/p/:sandboxId/:port/*');
    if (!isSchemaReady()) {
      return new Response(JSON.stringify({ error: 'Service starting up, try again shortly' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
      });
    }
    const prep = await preparePreviewWsUpgrade(url);
    if (!prep.ok) {
      console.warn(
        `[preview-ws] REFUSED ${prep.status} ${prep.message} path=${url.pathname} hasToken=${url.searchParams.has('token')}`,
      );
      return new Response(JSON.stringify({ error: prep.message }), {
        status: prep.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const success = server.upgrade(req, { data: prep.data });
    if (success) return undefined;
    return new Response(JSON.stringify({ error: 'WebSocket upgrade failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return app.fetch(req, server);
}
  return { dispatchInProcess, dispatchInbound };
}
