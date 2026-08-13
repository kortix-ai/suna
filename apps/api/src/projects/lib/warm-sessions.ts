/**
 * Warm sessions.
 *
 * A warm session is NOT a species of session. It is an ORDINARY session the
 * user created and has not typed into yet. The browser fires the same create the
 * New Session button fires, a few seconds earlier, while the user is looking at
 * the project. Everything the create path enforces — billing, the
 * concurrent-session cap, connector requirements, agent resolution, sandbox
 * provisioning — applies unchanged, because it IS the create path.
 *
 * That leaves exactly one thing to model: an unused session must not appear in
 * the sidebar, or every project visit would litter it with empty sessions the
 * user never started. ONE marker carries that, and nothing else:
 *
 *   `metadata.warm === true`  ⇒  created speculatively, never used.
 *
 * `POST /projects/:id/sessions/warm` writes it (projects/routes/warm-sessions.ts). The
 * `visible` list scope hides marked rows (projects/lib/session-inventory.ts).
 * `recordSessionActivity` DELETES it in the same statement that stamps the first
 * accepted turn (projects/session-activity.ts), so "used" and "last active" are
 * one fact written once and cannot drift apart. From that moment the row lists
 * like any other session.
 *
 * There is no state machine, no claim protocol, no compatibility matching, no
 * advisory lock and no unique index. A warm session that no longer suits the
 * user is abandoned by the client and reaped like any other idle box; a race
 * between two tabs costs one extra box, which the reserved concurrent-session
 * slot (`createProjectSession`'s `reserveConcurrentSlots`) already bounds.
 *
 * Deliberately dependency-free — `session-inventory.ts` is a pure module that
 * must stay importable without the database and config graph.
 */
export const WARM_SESSION_METADATA_KEY = 'warm';

/** True when this session was pre-created and nobody has prompted it yet. */
export function isWarmProjectSession(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  return (metadata as Record<string, unknown>)[WARM_SESSION_METADATA_KEY] === true;
}
