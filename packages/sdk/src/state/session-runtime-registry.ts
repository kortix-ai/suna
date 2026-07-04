/**
 * Session runtime registry — a process-wide map from a Kortix `sessionId` to
 * its last-resolved runtime (opencode session id + runtime URL + sandbox id).
 *
 * Why this exists: `kortix.session(pid, sid)` hands out a FRESH handle on
 * every call, with its own `_ready` cache that starts `null`. That is correct
 * isolation between two DIFFERENT sessions (see kortix.test.ts), but it also
 * means a second handle for the SAME session — e.g. a host polling
 * `.health()` on an interval with a new inline `kortix.session(...)` call each
 * tick, or the React `useSession` hook resolving the runtime independently of
 * a facade handle — has no way to know the session is already up.
 *
 * This registry is the seam that lets those two call paths share what they
 * learned: whichever one resolves a session's runtime first (via
 * `startProjectSession`, the one function both the facade's `ensureReady()`
 * and the React `useSession` hook call) writes it here, and every other
 * handle for that same session id can adopt the entry instead of throwing
 * `SessionNotReadyError` or re-issuing a `/start` POST.
 *
 * Deliberately NOT the old global "current runtime" (`./current-runtime`) —
 * that tracks a single "whichever sandbox is active right now" pointer, which
 * is exactly the footgun that let two session handles cross-wire. This is a
 * multi-entry map keyed by session id, so unrelated sessions never collide.
 *
 * Framework-free (no React) — part of the isomorphic core.
 */

export interface SessionRuntimeEntry {
  /** OpenCode's own session id for this Kortix session (resolved at /start). */
  opencodeSessionId: string;
  /** This session's resolved runtime proxy URL (`${backendUrl}/p/{externalId}/8000`). */
  runtimeUrl: string;
  /** The sandbox's provider external id (Daytona id). */
  sandboxId: string;
}

const registry = new Map<string, SessionRuntimeEntry>();

/** Key a registry entry by the (projectId, sessionId) pair it belongs to. */
function registryKey(projectId: string, sessionId: string): string {
  return `${projectId}::${sessionId}`;
}

/** Read a session's last-resolved runtime, if any handle has resolved it. */
export function getSessionRuntime(
  projectId: string,
  sessionId: string,
): SessionRuntimeEntry | undefined {
  return registry.get(registryKey(projectId, sessionId));
}

/** Record a session's resolved runtime so other handles can adopt it. */
export function setSessionRuntime(
  projectId: string,
  sessionId: string,
  entry: SessionRuntimeEntry,
): void {
  registry.set(registryKey(projectId, sessionId), entry);
}

/**
 * Drop a session's registry entry (restart/delete). A restart may re-provision
 * a different sandbox, so a stale entry would route subsequent calls at a dead
 * box — every handle must re-resolve via `ensureReady()`/`startProjectSession`.
 */
export function clearSessionRuntime(projectId: string, sessionId: string): void {
  registry.delete(registryKey(projectId, sessionId));
}
