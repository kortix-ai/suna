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

import { authenticatedFetch } from '../platform/auth';
import { getActiveOpenCodeUrl } from '../state/server-store/active';

export type SessionHealthResponse = {
  status?: string;
  runtimeReady?: boolean;
  version?: string;
  opencode?: string | boolean;
  boot_error?: string | null;
  reason?: string | null;
  message?: string | null;
};

export interface SessionHealthResult {
  /** HTTP status of the probe (0 when there is no active runtime URL). */
  status: number;
  ok: boolean;
  /** Parsed health body, or null when the response wasn't JSON. */
  health: SessionHealthResponse | null;
  /** Raw response text — useful for non-ok diagnostics. */
  body: string;
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
  if (!url) return { status: 0, ok: false, health: null, body: '' };
  const res = await authenticatedFetch(
    `${url}/kortix/health`,
    { method: 'GET', ...init },
    { retryOnAuthError: false },
  );
  const body = await res.text().catch(() => '');
  let health: SessionHealthResponse | null = null;
  try {
    health = body ? (JSON.parse(body) as SessionHealthResponse) : null;
  } catch {
    health = null;
  }
  return { status: res.status, ok: res.ok, health, body };
}
