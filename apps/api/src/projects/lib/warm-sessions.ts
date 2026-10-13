/**
 * Warm sessions.
 *
 * A warm session is NOT a species of session. It is an ORDINARY session the
 * user created and has not typed into yet. The browser fires the same create the
 * New Session button fires, a few seconds earlier, while the user is looking at
 * the project. Everything the create path enforces — billing, connector
 * requirements, agent resolution, sandbox provisioning — applies unchanged,
 * because it IS the create path.
 *
 * That leaves exactly one thing to model: an unused session must not appear in
 * the sidebar, or every project visit would litter it with empty sessions the
 * user never started. ONE marker carries that, and nothing else:
 *
 *   `metadata.warm === true`  ⇒  created speculatively, never used.
 *
 * `POST /projects/:id/sessions/warm` writes it (projects/routes/warm-sessions.ts). The
 * `visible` list scope hides marked rows (projects/lib/session-inventory.ts) — the
 * sidebar must never show an unprompted warm session, however live its box is
 * (product call 2026-10-12: a billed warm row listed as an untitled "New
 * session" that spins for the whole grant read as a broken session). A live
 * box still bills compute from creation (warmPoolGrantMs); the money stays
 * visible where lifecycle work happens — the manager `project` scope keeps a
 * live warm row for inspection, and open/stop/delete by id never consulted
 * the marker. The manager `project` scope
 * drops a soft-deleted warm draft in every scope: never prompted, nothing to
 * audit, and listing the
 * tombstone left the Sessions page's empty state unreachable. `recordSessionActivity`
 * DELETES the marker in the same statement that stamps the first accepted turn
 * (projects/session-activity.ts), so "used" and "last active" are one fact
 * written once and cannot drift apart. From that moment the row lists like
 * any other session.
 *
 * Compute placement is matched server-side before reuse or adoption. A
 * server-stamped requested location deduplicates in-flight warming but is
 * never proof of actual placement. Incompatible boxes are abandoned, not moved.
 * There is no advisory lock or unique index; a race between two tabs can cost
 * one extra box per racing tab, which bills and idles out like any session.
 *
 * Deliberately dependency-free — `session-inventory.ts` is a pure module that
 * must stay importable without the database and config graph.
 */
export const WARM_SESSION_METADATA_KEY = 'warm';
/** Server-owned intent for deduplicating pre-provider warm creation. */
export const WARM_SESSION_LOCATION_KEY = 'warmSandboxLocation';

/** True when this session was pre-created and nobody has prompted it yet. */
export function isWarmProjectSession(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  return (metadata as Record<string, unknown>)[WARM_SESSION_METADATA_KEY] === true;
}
