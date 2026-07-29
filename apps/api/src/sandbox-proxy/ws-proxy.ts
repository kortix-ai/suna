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
import { PROGRESS_GRANT_MS } from '../projects/lifetime/constants';
import { extendDeadline } from '../projects/lifetime/deadline';
import { sandboxDeadlinePtyPresenceEnabled } from '../projects/lifetime/flags';
import { observeControlPlaneEvent } from '../projects/lifetime/observation';

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
  // ── BOUNDED SANDBOX LIFETIME (W5) — observed interactive presence ─────────
  //
  // The original design named the `message` handler as the write site. It
  // cannot be: this state object carried no sandbox id, no session id and no DB
  // access, and the handler has nothing but `ws` and the bytes. So the identity
  // is resolved ONCE, at upgrade, where `principal.sessionId` and the sandbox
  // row are both already in hand, and stashed here.
  //
  // Two amendments to the naive version, both load-bearing:
  //
  //  - it grants a PROGRESS grant (2h), not an idle grace. The platform's own
  //    conclusion is written into the provider layer: a timer that "only sees
  //    inbound traffic" is "blind to local tool runs" and at short TTLs "WOULD
  //    kill working boxes (the 2026-06-24 stopped-too-quickly-mid-session
  //    class)". A 15-minute keystroke timer IS such a timer — an engineer
  //    running a 40-minute build types nothing, and losing that box loses the
  //    build, not "a dropped shell".
  //
  //  - it resets on frames in EITHER direction. Sandbox → client output is also
  //    a control-plane observation and proves the box is producing.
  /** Session that owns this socket; the write key. */
  sessionId: string;
  /** False when the socket's own credential is bound to this sandbox. */
  extendable: boolean;
  /** Monotonic ms of the last extension; throttles the per-frame path. */
  lastExtendedAtMs: number;
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
  const userId = principal.userId;

  // opencode PTY (and any other opencode endpoint) must reach opencode directly
  // on 4096 — the daemon on 8000 can't carry a WebSocket. Everything else is
  // proxied against the port the client addressed.
  const ptyKind = classifyPtyWebSocketPath(remainingPath);
  const upstreamPort = ptyKind === 'opencode' ? OPENCODE_INTERNAL_PORT : port;

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
      callerSessionId: principal.sessionId,
    });
    if (!upstream.ok) {
      return { ok: false, status: upstream.status, message: upstream.message };
    }
    return {
      ok: true,
      data: {
        type: 'preview-ws',
        url: upstream.url,
        headers: upstream.headers,
        sessionId: upstream.sessionId,
        extendable: upstream.extendable,
        lastExtendedAtMs: 0,
      },
    };
  } catch (err) {
    console.warn('[PREVIEW-WS] upstream resolve failed:', (err as Error)?.message || err);
    return { ok: false, status: 502, message: 'failed to resolve sandbox upstream' };
  }
}

/**
 * W5's write. Called on every frame in both directions, throttled hard.
 *
 * Self-authorship was already decided at upgrade (`extendable`), so a socket
 * the box opened with its own token extends nothing in either direction — which
 * is why the outbound direction can safely use a control-plane observation.
 *
 * Fire-and-forget and never throwing: a terminal frame must never be delayed or
 * dropped because a deadline write was slow.
 */
function notePreviewWsPresence(state: PreviewWsData): void {
  if (!sandboxDeadlinePtyPresenceEnabled()) return;
  if (!state.extendable) return;
  const now = Date.now();
  // A PTY streams frames per keystroke and per line of build output. One write
  // per minute keeps WAL proportional to sessions, not to characters typed; the
  // grant is 2h, so the throttle costs at most 60s of window.
  if (now - state.lastExtendedAtMs < 60_000) return;
  state.lastExtendedAtMs = now;
  void extendDeadline(
    { sessionId: state.sessionId },
    PROGRESS_GRANT_MS,
    observeControlPlaneEvent(),
  ).catch((err) =>
    console.warn('[lifetime] PTY presence extension failed (shadow mode, non-fatal):', err),
  );
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
      notePreviewWsPresence(state);
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
    notePreviewWsPresence(state);
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
