import { ScopedCache } from '../../platform/storage/managed-storage';
import { getCurrentRuntimeSandboxId } from '../../core/session/current-runtime';
import type {
  Session,
  Agent,
  Command,
  ProviderListResponse as SdkProviderListResponse,
} from '@opencode-ai/sdk/v2/client';

// ============================================================================
// Query Keys
// ============================================================================

/**
 * Active sandbox/server id, used to scope per-sandbox caches.
 *
 * Each project session is its OWN sandbox (session_id == sandbox_id), but the
 * OpenCode SDK client + caches are global. Without scoping, switching from
 * session A to B would show A's data under B — which is why the code used to
 * NUKE the entire opencode cache on every switch. That nuke is exactly what
 * made returning to an already-open session "reload".
 *
 * By appending the server id to per-sandbox cache keys, every sandbox's data
 * coexists in the cache, so returning to a warm session is instant and we no
 * longer need to tear anything down. Appended at the END so existing prefix
 * matches (e.g. invalidate `['opencode','sessions']`) still hit.
 *
 * `session(id)` / `messages(id)` stay global: opencode session ids are unique
 * per sandbox, so they never collide across sandboxes.
 */
export function activeServerKey(): string {
  try {
    return getCurrentRuntimeSandboxId() ?? 'none';
  } catch {
    return 'none';
  }
}

// ============================================================================
// Helper: unwrap SDK response (data / error)
// ============================================================================

export function unwrap<T>(result: { data?: T; error?: unknown; response?: Response }): T {
  if (result.error) {
    const err = result.error;
    const status = (result.response as Response | undefined)?.status;
    // Try to extract the most specific error message from the SDK response.
    // `error` is genuinely `unknown` here — its shape varies by which SDK
    // call produced it (typed error unions differ per endpoint) — so this
    // duck-types defensively instead of assuming a shape.
    const errRec = err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
    const dataRec =
      errRec?.data && typeof errRec.data === 'object' ? (errRec.data as Record<string, unknown>) : undefined;
    const msg =
      dataRec?.message ||
      errRec?.message ||
      errRec?.error ||
      (typeof err === 'string' ? err : null) ||
      (typeof err === 'object' ? JSON.stringify(err) : null) ||
      (status ? `Server returned ${status}` : 'SDK request failed');
    throw new Error(String(msg));
  }
  return result.data as T;
}

// ============================================================================
// Session Hooks
// ============================================================================

// localStorage placeholder caches are per-sandbox too — scope by active server
// id so re-opening a warm session paints its OWN last data, never the previous
// sandbox's. Scoping lives in the helpers so every call site inherits it.
//
// These are backed by ScopedCache, which caps each family to its N
// most-recently-used scopes. That cap is the whole point: the default scope is
// the EPHEMERAL per-sandbox server id, so without a cap every new session would
// leak a fresh `kortix_cache_*:<serverId>` blob forever and eventually blow the
// localStorage quota (which then crashes whatever store writes next). The cache
// is disposable — a miss just refetches — so small caps are safe.
export const LS_SESSIONS = 'kortix_cache_sessions';
export const LS_AGENTS = 'kortix_cache_agents';
export const LS_COMMANDS = 'kortix_cache_commands';
export const LS_PROVIDERS = 'kortix_cache_providers';

// Session/command lists are keyed per ephemeral sandbox — keep only the few
// most-recent sandboxes warm. Agents are keyed per directory (+ global), which
// is a small, stable space, so it gets more headroom. Providers are global.
const sessionsCache = new ScopedCache<Session[]>(LS_SESSIONS, 4);
const agentsCache = new ScopedCache<Agent[]>(LS_AGENTS, 8);
const commandsCache = new ScopedCache<Command[]>(LS_COMMANDS, 4);
const providersCache = new ScopedCache<SdkProviderListResponse>(LS_PROVIDERS, 2);

const cacheByFamily: Record<string, ScopedCache<unknown>> = {
  [LS_SESSIONS]: sessionsCache,
  [LS_AGENTS]: agentsCache,
  [LS_COMMANDS]: commandsCache,
  [LS_PROVIDERS]: providersCache,
};

export function getLSCache<T>(family: string, scope?: string): T | undefined {
  return cacheByFamily[family]?.get(scope ?? activeServerKey()) as T | undefined;
}

export function setLSCache(family: string, value: unknown, scope?: string): void {
  cacheByFamily[family]?.set(scope ?? activeServerKey(), value);
}

const PROJECT_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function canQueryOpenCodeSession(sessionId: string | null | undefined): sessionId is string {
  return !!sessionId && !PROJECT_SESSION_UUID_RE.test(sessionId);
}

export function clearProjectProviderCache(projectId: string): void {
  providersCache.remove(`proj:${projectId}:native`);
  providersCache.remove(`proj:${projectId}:gateway`);
}

/**
 * Stable cache scope for data that does NOT vary per sandbox. The default
 * scope is the ephemeral per-sandbox server id, which is correct for
 * session-specific data (session lists collide across sandboxes) but wrong for
 * platform/project-level data like the model list and the agent roster: those
 * are identical across every sandbox, yet a per-server key guarantees a cache
 * MISS on every brand-new session (new sandbox → new server id → never seen).
 * Keying them here instead lets a fresh session paint its pickers from cache on
 * the first frame, before the sandbox is even up — killing the visible pop-in.
 */
export const CACHE_SCOPE_GLOBAL = 'global';
