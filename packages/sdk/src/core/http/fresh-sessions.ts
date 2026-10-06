/**
 * Tracks sessions that were just created in THIS browser session, so the session
 * page can show the instant typeable shell (not the resume loader) for them.
 *
 * An in-memory Set — not sessionStorage — because creation and the subsequent
 * navigation happen in the same JS context (SPA pushState / client nav), so this
 * is immune to serialization, key-encoding, and write-ordering quirks. A hard
 * reload clears it, which is correct: a reloaded session is a resume, not new.
 */
const freshSessions = new Set<string>();
/** A window that creates thousands of sessions forgets the oldest marks. */
const MAX_FRESH_SESSIONS = 500;

export function markSessionFresh(id: string | null | undefined): void {
  if (!id) return;
  freshSessions.add(id);
  if (freshSessions.size > MAX_FRESH_SESSIONS) {
    freshSessions.delete(freshSessions.values().next().value as string);
  }
}

export function isSessionFresh(id: string | null | undefined): boolean {
  return !!id && freshSessions.has(id);
}

export function clearSessionFresh(id: string | null | undefined): void {
  if (id) freshSessions.delete(id);
}
