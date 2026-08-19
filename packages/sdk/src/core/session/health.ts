/**
 * Session runtime health — `GET /kortix/health` on the session's runtime.
 *
 * The host asks a session whether its runtime is ready; it never reasons about
 * "the sandbox" directly. This is the liveness probe used to gate "runtime
 * active" vs "OpenCode ready". The runtime-ready parsing rule lives here so
 * every consumer interprets a payload identically. It never throws on a non-ok
 * HTTP status — it surfaces `status`/`ok` so the caller applies its own failure
 * thresholds.
 *
 * NOTE: the legacy `GET /kortix/ports` endpoint is intentionally NOT wrapped —
 * the current agent server (rewritten 2026-05) serves no such route; port
 * mappings come from the platform API, and live port access is the
 * `/proxy/:port/*` reverse proxy (see `./url`).
 */

import { authenticatedFetch } from '../http/auth';
import { getActiveOpenCodeUrl } from './server-store/active';

export type SessionHealthResponse = {
  status?: string;
  runtimeReady?: boolean;
  version?: string;
  opencode?: string | boolean;
  boot_error?: string | null;
  reason?: string | null;
  message?: string | null;
};

/**
 * Which hop of the sandbox proxy produced a failure, as the proxy itself
 * reports it. Mirrors `apps/api/src/sandbox-proxy/proxy-hop.ts` — the two lists
 * are one wire contract and must not drift.
 *
 *   - `control_plane`    — the platform answered from the session row; the box
 *                          was never dialled.
 *   - `provider_ingress` — no address for the box, or its edge refused.
 *   - `daemon`           — the box answers, the runtime process does not.
 *   - `upstream_port`    — the user's own process on an app port is down.
 *
 * Only the middle two are evidence that the RUNTIME is unreachable.
 */
export type ProxyHop = 'control_plane' | 'provider_ingress' | 'daemon' | 'upstream_port';

const PROXY_HOPS: readonly string[] = [
  'control_plane',
  'provider_ingress',
  'daemon',
  'upstream_port',
];

/** Narrow an untrusted header/body value to a hop, or null. Anything the proxy
 *  did not attribute — an intermediary's own 502, an older deployment — must
 *  read as "unattributed", never as a hop we happen to be lenient about. */
export function parseProxyHop(value: unknown): ProxyHop | null {
  return typeof value === 'string' && PROXY_HOPS.includes(value) ? (value as ProxyHop) : null;
}

export interface SessionHealthResult {
  /** HTTP status of the probe (0 when there is no active runtime URL). */
  status: number;
  ok: boolean;
  /** Parsed health body, or null when the response wasn't JSON. */
  health: SessionHealthResponse | null;
  /** Raw response text — useful for non-ok diagnostics. */
  body: string;
  /** Which proxy hop produced a failure, or null when nothing attributed it. */
  hop: ProxyHop | null;
  /** The status the failing hop itself returned, when it returned one. */
  upstreamStatus: number | null;
}

/** Whether a health payload indicates the OpenCode runtime is ready. */
export function isRuntimeReady(health: SessionHealthResponse | null): boolean {
  if (!health) return false;
  if (health.runtimeReady !== undefined) return health.runtimeReady === true;
  if (health.opencode !== undefined)
    return health.opencode === 'ok' || health.opencode === true;
  return (
    health.status !== 'starting' &&
    health.status !== 'down' &&
    health.status !== 'error'
  );
}

/**
 * `GET /kortix/health` — returns the HTTP status plus the parsed body. Never
 * throws on a non-ok status; callers decide what a given status means.
 *
 * `runtimeUrl` OMITTED (`undefined`) falls back to the module-global "active"
 * runtime, for callers that don't scope to a specific session. Passing `null`
 * or `''` EXPLICITLY means "this session has no resolved runtime yet" and
 * short-circuits to the graceful `{ status: 0, ok: false }` shape WITHOUT
 * falling back to the active runtime — a per-session handle (e.g.
 * `kortix.session(pid, sid).health()`) must never silently probe whichever
 * DIFFERENT session's sandbox happens to be globally active.
 */
export async function getSessionHealth(
  runtimeUrl?: string | null,
  init?: RequestInit,
): Promise<SessionHealthResult> {
  const url = (runtimeUrl === undefined ? getActiveOpenCodeUrl() : runtimeUrl) || null;
  if (!url)
    return { status: 0, ok: false, health: null, body: '', hop: null, upstreamStatus: null };
  const res = await authenticatedFetch(
    `${url}/kortix/health`,
    { method: 'GET', ...init },
    { retryOnAuthError: false },
  );
  const body = await res.text().catch(() => '');
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  const health = parsed as SessionHealthResponse | null;
  // Header first, body second. The header survives a HEAD and the proxy's HTML
  // error page; the body fallback covers a deployment whose CORS config does not
  // expose the header yet, where reading it would silently yield null.
  const hop = parseProxyHop(res.headers.get('X-Kortix-Proxy-Hop')) ?? parseProxyHop(parsed?.hop);
  // `Number(null)` and `Number('')` are both 0, so the `> 0` guard is what
  // separates "absent" from a real status — there is no HTTP status 0.
  const headerUpstream = Number(res.headers.get('X-Kortix-Upstream-Status'));
  const bodyUpstream = parsed?.upstream_status;
  const upstreamStatus =
    Number.isFinite(headerUpstream) && headerUpstream > 0
      ? headerUpstream
      : typeof bodyUpstream === 'number'
        ? bodyUpstream
        : null;
  return { status: res.status, ok: res.ok, health, body, hop, upstreamStatus };
}
