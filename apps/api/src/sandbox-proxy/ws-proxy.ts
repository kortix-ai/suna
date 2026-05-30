// ════════════════════════════════════════════════════════════════════════════
// Preview WebSocket reverse-proxy
//
// The path-based preview proxy (`/v1/p/{sandboxId}/{port}/*`) is an HTTP-only
// reverse proxy (see routes/preview.ts). Browser WebSocket clients — today the
// xterm PTY terminal — need a real upgrade, which Hono/`fetch()` can't do; the
// upgrade has to happen at the `Bun.serve()` level.
//
// This module:
//   1. authenticates the upgrade via the `?token=` query param (browsers can't
//      set Authorization headers on a WebSocket) — mirroring `combinedAuth`,
//   2. resolves the upstream WS URL + headers (Daytona preview link + service
//      key + signed user-context), and
//   3. pipes bytes both ways once Bun upgrades the client socket.
//
// IMPORTANT — opencode PTY targets port 4096, not 8000.
// The in-sandbox daemon on port 8000 is an HTTP-only reverse proxy: it strips
// the `Upgrade` header and has no `websocket` handler, so a WS can never reach
// opencode through it. opencode serves its PTY WebSocket (`/pty/{id}/connect`)
// directly on its internal port 4096, which Daytona can expose via its own
// preview link. So for any `/pty/` path we resolve the upstream against port
// 4096 regardless of the port the client addressed.
// ════════════════════════════════════════════════════════════════════════════

import { authenticatePreviewPrincipal } from './preview-auth';
import { resolvePreviewWsUpstream } from './routes/preview';

// opencode's internal port — its PTY WebSocket endpoint lives here, reachable
// via a dedicated Daytona preview link (the daemon on 8000 can't proxy WS).
const OPENCODE_INTERNAL_PORT = 4096;

/** Per-connection state stashed on the upgraded socket's `data`. */
export interface PreviewWsData {
  type: 'preview-ws';
  url: string;
  headers: Record<string, string>;
  // Populated in the `open` handler once the upstream socket exists.
  upstream?: WebSocket;
  ready?: boolean;
  queue?: Array<string | Buffer | ArrayBuffer | Uint8Array>;
}

/** Minimal shape of the Bun server WebSocket we touch. */
interface ServerWs {
  data: PreviewWsData;
  send: (data: string | ArrayBufferView | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
}

/** True when the path is a path-based preview route eligible for WS proxying. */
export function matchPreviewWsPath(
  pathname: string,
): { sandboxId: string; port: number; remainingPath: string } | null {
  const m = pathname.match(/^\/v1\/p\/([^/]+)\/(\d+)(\/.*)?$/);
  if (!m) return null;
  const sandboxId = m[1];
  if (sandboxId === 'auth' || sandboxId === 'share') return null;
  const port = parseInt(m[2], 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) return null;
  return { sandboxId, port, remainingPath: m[3] || '/' };
}

/**
 * Authenticate + resolve everything needed to upgrade a preview WS.
 * On success returns the `data` payload to hand to `server.upgrade`.
 * On failure returns an HTTP status + message for the caller to respond with.
 */
export async function preparePreviewWsUpgrade(
  url: URL,
): Promise<
  | { ok: true; data: PreviewWsData }
  | { ok: false; status: number; message: string }
> {
  const match = matchPreviewWsPath(url.pathname);
  if (!match) return { ok: false, status: 404, message: 'not a preview route' };

  const { sandboxId, port, remainingPath } = match;

  const userId = await authenticatePreviewPrincipal(url.searchParams.get('token'), sandboxId);
  if (!userId) return { ok: false, status: 401, message: 'unauthorized' };

  // opencode PTY (and any other opencode endpoint) must reach opencode directly
  // on 4096 — the daemon on 8000 can't carry a WebSocket. Everything else is
  // proxied against the port the client addressed.
  const upstreamPort = remainingPath.startsWith('/pty/') ? OPENCODE_INTERNAL_PORT : port;

  // Strip our own auth token before forwarding — opencode authenticates via the
  // Daytona preview token header, not our query param.
  const upstreamQuery = new URLSearchParams(url.search);
  upstreamQuery.delete('token');
  const queryString = upstreamQuery.toString() ? `?${upstreamQuery.toString()}` : '';

  try {
    const upstream = await resolvePreviewWsUpstream({
      sandboxId,
      upstreamPort,
      userId,
      remainingPath,
      queryString,
    });
    if (!upstream.ok) {
      return { ok: false, status: upstream.status, message: upstream.message };
    }
    return {
      ok: true,
      data: { type: 'preview-ws', url: upstream.url, headers: upstream.headers },
    };
  } catch (err) {
    console.warn('[PREVIEW-WS] upstream resolve failed:', (err as Error)?.message || err);
    return { ok: false, status: 502, message: 'failed to resolve sandbox upstream' };
  }
}

// WebSocket close codes are constrained: a server may only emit 1000 or
// 3000–4999. Anything else (1006 abnormal, 1005 no-status, …) must be mapped.
function sanitizeCloseCode(code: number | undefined): number {
  if (typeof code !== 'number') return 1000;
  if (code === 1000) return 1000;
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}

// ── Byte-piping handlers, wired into Bun.serve's `websocket` config ──────────

export const previewWsHandlers = {
  open(ws: ServerWs) {
    const state = ws.data;
    state.queue = [];
    state.ready = false;

    let upstream: WebSocket;
    try {
      // Bun extends the WebSocket constructor with a `headers` option so we can
      // forward the Daytona preview token / service key / signed user-context.
      upstream = new WebSocket(state.url, { headers: state.headers } as any);
    } catch (err) {
      console.warn('[PREVIEW-WS] upstream connect threw:', (err as Error)?.message || err);
      try { ws.close(1011, 'upstream connect failed'); } catch {}
      return;
    }

    upstream.binaryType = 'arraybuffer';
    state.upstream = upstream;

    upstream.onopen = () => {
      state.ready = true;
      const queued = state.queue ?? [];
      state.queue = [];
      for (const msg of queued) {
        try { upstream.send(msg as any); } catch {}
      }
    };

    upstream.onmessage = (ev: MessageEvent) => {
      try { ws.send(ev.data as any); } catch {}
    };

    upstream.onclose = (ev: CloseEvent) => {
      try { ws.close(sanitizeCloseCode(ev.code), (ev.reason || '').slice(0, 120)); } catch {}
    };

    upstream.onerror = () => {
      try { ws.close(1011, 'upstream error'); } catch {}
    };
  },

  message(ws: ServerWs, message: string | Buffer) {
    const state = ws.data;
    const upstream = state.upstream;
    if (state.ready && upstream && upstream.readyState === WebSocket.OPEN) {
      try { upstream.send(message as any); } catch {}
    } else {
      (state.queue ??= []).push(message);
    }
  },

  close(ws: ServerWs) {
    try { ws.data.upstream?.close(); } catch {}
  },
};
