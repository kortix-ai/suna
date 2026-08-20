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
// IMPORTANT — opencode PTY usually targets port 4096, not 8000.
// opencode serves its PTY WebSocket (`/pty/{id}/connect`) directly on its
// internal port 4096. Daytona can expose that port directly. Platinum cannot:
// the opencode process is loopback-bound and direct public exposure would bypass
// the sandbox agent's signed user-context auth. The resolver therefore keeps
// Daytona on 4096 and sends Platinum PTY upgrades through the agent bridge on
// 8000.
// ════════════════════════════════════════════════════════════════════════════

import { authenticatePreviewPrincipalDetailed } from './preview-auth';
import { resolvePreviewWsUpstream } from './routes/preview';
import { classifyPtyWebSocketPath } from '../platform/providers/pty-ingress';
import { OPENCODE_PRIMARY_PORT, isOpencodePort } from '../shared/opencode-ports';
import { resolveSandboxIngress } from './backend';
import { establishPreviewSession, resolvePreviewRequest, sessionFromCookies } from './preview-origin';

// opencode's PTY WebSocket endpoint lives on opencode's own port, reachable via
// a dedicated Daytona preview link (the daemon on 8000 can't proxy WS).
//
// That port MOVES. A verified config reload boots the replacement opencode on
// the idle half of the port pair and promotes it, so after one reload the live
// port is the other half and this constant points at a dead socket. It is now
// only the fallback for a daemon too old to report where opencode actually is.
const OPENCODE_FALLBACK_PORT = OPENCODE_PRIMARY_PORT;

/** The daemon's own port — where its health endpoint answers. */
const AGENT_PORT = 8000;

/**
 * Ask the box which port opencode is on right now.
 *
 * Deliberately NOT cached: the value changes on exactly the event we care about
 * (a reload), so a cache would be stale precisely when it matters and would
 * reintroduce the dead-socket bug it was meant to avoid. A PTY connect is a
 * human opening a terminal — rare enough to afford one short round-trip.
 *
 * Falls back to 4096 on anything unexpected: an older daemon that does not
 * report the field, an unreachable box, a slow one. That is the previous
 * behaviour, so this can only improve on it.
 */
async function resolveLiveOpencodePort(sandboxId: string): Promise<number> {
  try {
    const { url, headers } = await resolveSandboxIngress(sandboxId, {
      port: AGENT_PORT,
      transport: 'http',
    });
    const res = await fetch(`${url.replace(/\/$/, '')}/kortix/health`, {
      headers,
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return OPENCODE_FALLBACK_PORT;
    const body = (await res.json().catch(() => null)) as { opencode_port?: unknown } | null;
    const port = body?.opencode_port;
    // Must be one of the pair. A daemon reporting anything else is either
    // misconfigured or not the daemon, and following it blindly would let a
    // response body redirect the PTY at an arbitrary port inside the sandbox.
    return typeof port === 'number' && Number.isInteger(port) && isOpencodePort(port)
      ? port
      : OPENCODE_FALLBACK_PORT;
  } catch {
    return OPENCODE_FALLBACK_PORT;
  }
}

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

  const principal = await authenticatePreviewPrincipalDetailed(
    url.searchParams.get('token'),
    sandboxId,
  );
  if (!principal) return { ok: false, status: 401, message: 'unauthorized' };

  return resolveUpgradeForPrincipal({
    sandboxId,
    port,
    remainingPath,
    search: url.search,
    userId: principal.userId,
    callerSessionId: principal.sessionId,
  });
}

/**
 * Upgrade a WebSocket that arrived on a preview ORIGIN.
 *
 * The path form authenticates with `?token=` because it has nowhere else to put
 * a credential. An app on its own origin does not have that option at all: it
 * writes `new WebSocket('/hmr')`, and neither a header nor a query parameter is
 * reachable from that call — which is exactly why the origin proxy issues a
 * cookie. WebSocket handshakes are ordinary HTTP requests and carry it.
 *
 * Sandbox and port come from the Host header, so the whole path belongs to the
 * app; `/v1/p/...` means nothing here.
 */
export async function preparePreviewHostWsUpgrade(
  req: Request,
  url: URL,
): Promise<
  | { ok: true; data: PreviewWsData }
  | { ok: false; status: number; message: string }
> {
  const resolved = resolvePreviewRequest(req, url);
  if (!resolved) return { ok: false, status: 404, message: 'not a preview host' };
  if (!resolved.verified) return { ok: false, status: 403, message: 'unsigned preview host' };
  const { target } = resolved;

  let session = sessionFromCookies(req, target);
  if (!session) {
    // No cookie yet — accept the same one-shot credential the HTTP handshake
    // takes, so a client that opens a socket before any page load still works.
    const established = await establishPreviewSession(req, url, target);
    if ('response' in established) {
      return { ok: false, status: established.response.status, message: 'unauthorized' };
    }
    session = established.session;
  }
  if (session.kind !== 'principal') {
    // A public share is a read-only view of an artifact, not a socket.
    return { ok: false, status: 403, message: 'websocket not available on a shared preview' };
  }

  return resolveUpgradeForPrincipal({
    sandboxId: session.sandboxId,
    port: target.port,
    remainingPath: url.pathname || '/',
    search: url.search,
    userId: session.userId,
    callerSessionId: session.callerSessionId,
  });
}

/** Shared tail of both upgrade paths: pick the upstream port and resolve it. */
async function resolveUpgradeForPrincipal(input: {
  sandboxId: string;
  port: number;
  remainingPath: string;
  search: string;
  userId: string;
  callerSessionId: string | null;
}): Promise<
  | { ok: true; data: PreviewWsData }
  | { ok: false; status: number; message: string }
> {
  const { sandboxId, port, remainingPath, userId, callerSessionId } = input;

  // opencode PTY (and any other opencode endpoint) must reach opencode directly
  // on 4096 — the daemon on 8000 can't carry a WebSocket. Everything else is
  // proxied against the port the client addressed.
  const ptyKind = classifyPtyWebSocketPath(remainingPath);
  const upstreamPort =
    ptyKind === 'opencode' ? await resolveLiveOpencodePort(sandboxId) : port;

  // Strip our own auth credentials before forwarding — opencode authenticates
  // via the Daytona preview token header, not our query params.
  const upstreamQuery = new URLSearchParams(input.search);
  upstreamQuery.delete('token');
  upstreamQuery.delete('public_share');
  const queryString = upstreamQuery.toString() ? `?${upstreamQuery.toString()}` : '';

  try {
    const upstream = await resolvePreviewWsUpstream({
      sandboxId,
      upstreamPort,
      userId,
      remainingPath,
      queryString,
      callerSessionId,
      // A PreviewPrincipal's sessionId is the SANDBOX's own token binding, never
      // a Supabase login id — so it is also the correct agent binding.
      boundCredentialSessionId: callerSessionId,
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

// Preserve meaningful standard close codes, but never emit reserved wire-only
// values (1005/1006) or an arbitrary invalid number.
export function sanitizePreviewWsCloseCode(code: number | undefined): number {
  // 1004/1005/1006/1015 are reserved and cannot be emitted on the wire. Keep
  // every other standard close code intact so clients can distinguish a clean
  // shell exit from an upstream restart/server failure. Unknown values use a
  // stable application code instead of being disguised as a normal 1000 close.
  if (
    typeof code === 'number' &&
    ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
      (code >= 3000 && code <= 4999))
  ) {
    return code;
  }
  return 4500;
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
      try { ws.close(sanitizePreviewWsCloseCode(ev.code), (ev.reason || '').slice(0, 120)); } catch {}
    };

    upstream.onerror = () => {
      try { ws.close(4502, 'upstream error'); } catch {}
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
