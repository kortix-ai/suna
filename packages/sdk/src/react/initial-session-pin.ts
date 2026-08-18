interface SessionPinSources {
  startPin?: string | null;
  initialPin?: string | null;
  persistedPin?: string | null;
}

export function resolveSessionPin({
  startPin,
  initialPin,
  persistedPin,
}: SessionPinSources): string | null {
  return startPin ?? initialPin ?? persistedPin ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// T6 — a synchronous, local mirror of the server-persisted pin.
//
// `persistedPin` above used to be fed ONLY from `getProjectSession` (a REST
// round trip via `useProjectSession`). That is real, durable, server-side
// storage — but it is never available on the FIRST render of a cold mount, so
// `useCanonicalOpenCodeSession` painted nothing until that fetch (or /start's
// much slower long-poll) came back, even for a session whose transcript was
// already sitting in this browser's IDB cache under the very id we're waiting
// to learn.
//
// `readPersistedSessionPin` mirrors the LAST canonical id this browser saw for
// (projectId, sessionId) in `localStorage` — a synchronous read, so it can
// feed `persistedPin` on the very first render, before any network call
// resolves. It is a cache, never a source of truth: `resolvePersistedPin`
// below always lets the network value win the moment it loads, and
// `resolveSessionPin`'s own precedence always lets a live /start pin win over
// everything. A stale entry here can only ever cost one render's worth of
// showing the previous transcript before something more authoritative
// corrects it — never a permanent wrong display.
// ─────────────────────────────────────────────────────────────────────────────

export function sessionPinStorageKey(projectId: string, sessionId: string): string {
  return `kortix:pin:${projectId}/${sessionId}`;
}

/** Synchronous. Never throws — a private/quota-exceeded browser or a
 *  server-side render (no `localStorage` global) both fall through to `null`,
 *  which is exactly "nothing cached yet" to every caller. */
export function readPersistedSessionPin(projectId: string, sessionId: string): string | null {
  if (!projectId || !sessionId) return null;
  try {
    return localStorage.getItem(sessionPinStorageKey(projectId, sessionId)) || null;
  } catch {
    return null;
  }
}

/** Mirrors a freshly-resolved canonical id so the NEXT mount of this session
 *  can paint synchronously. Never throws, and never writes an empty/falsy id
 *  — an unresolved pin must not clobber a good one already on disk. */
export function writePersistedSessionPin(
  projectId: string,
  sessionId: string,
  opencodeSessionId: string | null | undefined,
): void {
  if (!projectId || !sessionId || !opencodeSessionId) return;
  try {
    localStorage.setItem(sessionPinStorageKey(projectId, sessionId), opencodeSessionId);
  } catch {
    // Best-effort. Worst case the next mount re-waits on the network, exactly
    // as it did before this cache existed.
  }
}

/** The network read (`getProjectSession`'s `opencode_session_id`) always wins
 *  once it has loaded — it is more authoritative than a local echo of a
 *  possibly-stale prior pin. Before it loads, fall back to the synchronous
 *  local cache so there is something to paint with on the first render. */
export function resolvePersistedPin(input: {
  networkPin?: string | null;
  cachedPin?: string | null;
}): string | null {
  return input.networkPin ?? input.cachedPin ?? null;
}
