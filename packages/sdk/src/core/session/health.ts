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
import { getActiveRuntimeUrl } from './server-store/active';

export type SessionHealthResponse = {
  status?: string;
  runtimeReady?: boolean;
  version?: string;
  /**
   * The session runtime's own report (daemons since W3). `ready` means the
   * harness can take a prompt; `runtimeReady` adds the host's workspace checks.
   */
  harness?: {
    /** `opencode` or `pi`. */
    id: string;
    version: string | null;
    /** The runtime process: `starting`, `ok`, `down` or `error`. */
    state: string;
    ready: boolean;
    error: string | null;
    session: { id: string | null; required: boolean };
    turn: { in_flight: boolean | null; end: string | null; orphaned_prompt: boolean } | null;
    details: Record<string, unknown>;
  };
  /** @deprecated The runtime process state before W3. Read `harness.state`. */
  opencode?: string | boolean;
  boot_error?: string | null;
  reason?: string | null;
  message?: string | null;
  /**
   * What the daemon serves: host routes (`file.import`, ...) and, since W3,
   * the session features of its runtime (`session.rewind`, ...). Read it with
   * {@link runtimeSupports}.
   */
  capabilities?: string[];
};

/**
 * A session feature a runtime may or may not serve. Mirrors
 * `RUNTIME_CAPABILITIES` in `@kortix/api-contract/runtime-relay`.
 *
 *   - `session.rewind`    revert to a message, and restore it
 *   - `session.compact`   summarize the conversation on demand
 *   - `session.commands`  project slash commands
 *   - `session.fork`      fork a session at a message
 *   - `session.subagents` subagent child sessions
 *   - `session.mcp`       MCP servers the runtime connects itself
 *   - `session.todo`      the runtime's todo list
 *   - `session.shell`     a shell command run as a turn
 *   - `session.attach`    attach the harness's own terminal client
 *   - `session.config`    a runtime config document (`/global/config`)
 */
export type RuntimeCapability =
  | 'session.rewind'
  | 'session.compact'
  | 'session.commands'
  | 'session.fork'
  | 'session.subagents'
  | 'session.mcp'
  | 'session.todo'
  | 'session.shell'
  | 'session.attach'
  | 'session.config';

/**
 * Does the session's runtime serve `capability`? Pass the health
 * `capabilities` list. A host hides the control of an absent feature instead
 * of letting it fail with `501 feature_not_supported`.
 *
 * A list with no `session.*` entry comes from a daemon built before runtime
 * capabilities existed; that daemon runs OpenCode, which serves every
 * feature. `null`/`undefined` (no probe answered yet) hides nothing either.
 */
export function runtimeSupports(
  capabilities: readonly string[] | null | undefined,
  capability: RuntimeCapability,
): boolean {
  if (!capabilities?.some((entry) => entry.startsWith('session.'))) return true;
  return capabilities.includes(capability);
}

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

/**
 * Whether a health payload indicates the session runtime is ready: the host's
 * `runtimeReady`, else the `harness` block, else the pre-W3 `opencode` field.
 */
export function isRuntimeReady(health: SessionHealthResponse | null): boolean {
  if (!health) return false;
  if (health.runtimeReady !== undefined) return health.runtimeReady === true;
  if (health.harness) return health.harness.ready === true;
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
  const url = (runtimeUrl === undefined ? getActiveRuntimeUrl() : runtimeUrl) || null;
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
