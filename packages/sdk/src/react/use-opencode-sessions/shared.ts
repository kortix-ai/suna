import { getCurrentRuntimeSandboxId } from '../../core/session/current-runtime';

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
 * Session and message keys also include this scope. Warm snapshots can contain
 * a baked OpenCode id before each fork rotates to its final root. Cache safety
 * must not depend on that rotation completing before a client reads data.
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

export function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response?: Response;
}): T {
  if (result.error) {
    const err = result.error;
    const status = (result.response as Response | undefined)?.status;
    // Try to extract the most specific error message from the SDK response.
    // `error` is genuinely `unknown` here — its shape varies by which SDK
    // call produced it (typed error unions differ per endpoint) — so this
    // duck-types defensively instead of assuming a shape.
    const errRec = err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
    const dataRec =
      errRec?.data && typeof errRec.data === 'object'
        ? (errRec.data as Record<string, unknown>)
        : undefined;
    const msg =
      dataRec?.message ||
      errRec?.message ||
      errRec?.error ||
      (typeof err === 'string' ? err : null) ||
      (typeof err === 'object' ? JSON.stringify(err) : null) ||
      (status ? `Server returned ${status}` : 'SDK request failed');
    // Carry the HTTP status on the thrown error. Every retry policy in this
    // directory (and the web QueryClient's default) classifies on `error.status`:
    // a status-less throw made a dead-token 401 look retryable and produced an
    // 11-request warn storm on the picker queries (prod, 2026-10-02). The SSE
    // transport throws the same shape (`Object.assign(new Error, { status })`).
    throw status ? Object.assign(new Error(String(msg)), { status }) : new Error(String(msg));
  }
  return result.data as T;
}

// ============================================================================
// Helper: shape guard for runtime LIST endpoints
// ============================================================================

/**
 * Coerce a runtime list response to an array.
 *
 * The OpenCode REST types say `GET /command`, `GET /agent`, … return an array,
 * but the value that actually arrives does not always agree: a daemon or proxy
 * that answers a list route with an object body hands the caller a TRUTHY
 * non-array. Consumers iterate the list (`for…of`, `.find`, `.some`,
 * `.filter`), so that value does not degrade — it throws
 * `TypeError: <x> is not iterable` inside a render and takes the whole session
 * view down with it (dev, 2026-08-23). Normalize at the seam so an unexpected
 * body reads as "no items" instead.
 *
 * This is the list-level twin of `detectCommandFromText`'s per-item
 * `typeof cmd.template !== 'string'` guard in `apps/web`.
 */
export function asRuntimeList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const PROJECT_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function canQueryRuntimeSession(sessionId: string | null | undefined): sessionId is string {
  return !!sessionId && !PROJECT_SESSION_UUID_RE.test(sessionId);
}

/**
 * @deprecated The provider lists are no longer kept in localStorage, so there
 * is nothing to clear. Does nothing. Removed in the next major.
 */
export function clearProjectProviderCache(_projectId: string): void {}

// Pre-W4 names, kept until the next major. The runtime is OpenCode or pi.
/** @deprecated Renamed to `canQueryRuntimeSession`. Removed in the next major. */
export const canQueryOpenCodeSession = canQueryRuntimeSession;
