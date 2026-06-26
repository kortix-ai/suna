/**
 * Sandbox health reads — daemon `GET /kortix/health`.
 *
 * This is the liveness probe the cloud and the host use to gate "sandbox active"
 * vs "OpenCode runtime ready". The runtime-ready parsing rule lives here so every
 * consumer interprets a health payload identically. It never throws on a non-ok
 * HTTP status — it surfaces `status`/`ok` so the caller can apply its own failure
 * thresholds.
 *
 * NOTE: the legacy `GET /kortix/ports` endpoint is intentionally NOT wrapped — the
 * current agent server (rewritten 2026-05) serves no such route; container→host
 * port mappings come from the platform API / server-store, and live port access is
 * the `/proxy/:port/*` reverse proxy (see `./url`).
 */

import { authenticatedFetch } from '../platform/auth';
import { getActiveOpenCodeUrl } from '../state/server-store';

export type SandboxHealthResponse = {
  status?: string;
  runtimeReady?: boolean;
  version?: string;
  opencode?: string | boolean;
  boot_error?: string | null;
  reason?: string | null;
  message?: string | null;
};

export interface SandboxHealthResult {
  /** HTTP status of the probe (0 when there is no active server URL). */
  status: number;
  ok: boolean;
  /** Parsed health body, or null when the response wasn't JSON. */
  health: SandboxHealthResponse | null;
  /** Raw response text — useful for non-ok diagnostics. */
  body: string;
}

/** Whether a health payload indicates the OpenCode runtime is ready. */
export function isRuntimeReady(health: SandboxHealthResponse | null): boolean {
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
 */
export async function getSandboxHealth(
  serverUrl?: string | null,
  init?: RequestInit,
): Promise<SandboxHealthResult> {
  const url = (serverUrl ?? getActiveOpenCodeUrl()) || null;
  if (!url) return { status: 0, ok: false, health: null, body: '' };
  const res = await authenticatedFetch(
    `${url}/kortix/health`,
    { method: 'GET', ...init },
    { retryOnAuthError: false },
  );
  const body = await res.text().catch(() => '');
  let health: SandboxHealthResponse | null = null;
  try {
    health = body ? (JSON.parse(body) as SandboxHealthResponse) : null;
  } catch {
    health = null;
  }
  return { status: res.status, ok: res.ok, health, body };
}
