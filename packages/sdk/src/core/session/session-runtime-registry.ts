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

/**
 * Bound on live entries. A long-lived server process juggling many short
 * sessions would otherwise grow this map forever (nothing but explicit
 * restart/delete/stop ever removed an entry). Eviction is safe by
 * construction: an evicted entry is indistinguishable from a session whose
 * runtime was simply never resolved yet — `tryResolveReady()` in
 * `kortix.ts` treats a registry miss as "not cached", falling back to
 * `ensureReady()` → `startProjectSession`, which re-resolves (and
 * re-populates) the entry. No consumer treats a miss as an error on its own;
 * `requireReady()` is the only place a miss becomes a thrown
 * `SessionNotReadyError`, and that's the pre-existing behavior for any
 * session whose runtime hasn't been resolved by ANY handle yet.
 */
const MAX_ENTRIES = 512;

// Map iteration order is insertion order, so re-inserting a key (via
// `delete` + `set`) on every read/write is what gives us LRU-by-recency:
// the least-recently-touched entry is always the first one `.keys()`
// yields, which is exactly what we evict on overflow.
const registry = new Map<string, SessionRuntimeEntry>();

/** Key a registry entry by the (projectId, sessionId) pair it belongs to. */
function registryKey(projectId: string, sessionId: string): string {
  return `${projectId}::${sessionId}`;
}

/** Move `key` to the most-recently-used end of the map (re-insert). */
function touch(key: string, entry: SessionRuntimeEntry): void {
  registry.delete(key);
  registry.set(key, entry);
}

/** Read a session's last-resolved runtime, if any handle has resolved it. */
export function getSessionRuntime(
  projectId: string,
  sessionId: string,
): SessionRuntimeEntry | undefined {
  const key = registryKey(projectId, sessionId);
  const entry = registry.get(key);
  if (entry) touch(key, entry);
  return entry;
}

/**
 * Record a session's resolved runtime so other handles can adopt it. Evicts
 * the least-recently-used entry first if inserting a NEW key would push the
 * registry past `MAX_ENTRIES` — see the eviction-safety note above.
 */
export function setSessionRuntime(
  projectId: string,
  sessionId: string,
  entry: SessionRuntimeEntry,
): void {
  const key = registryKey(projectId, sessionId);
  if (!registry.has(key) && registry.size >= MAX_ENTRIES) {
    const oldestKey = registry.keys().next().value;
    if (oldestKey !== undefined) registry.delete(oldestKey);
  }
  touch(key, entry);
}

/**
 * Drop a session's registry entry (restart/delete). Restart preserves the
 * established sandbox identity, but every handle must still re-resolve
 * readiness via `ensureReady()`/`startProjectSession` after the reboot.
 */
export function clearSessionRuntime(projectId: string, sessionId: string): void {
  registry.delete(registryKey(projectId, sessionId));
}
