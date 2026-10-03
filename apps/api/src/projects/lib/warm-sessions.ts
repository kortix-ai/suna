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
 * `visible` list scope hides marked rows whose session is not actively
 * provisioning or running (projects/lib/session-inventory.ts): a live box
 * bills compute from creation (warmPoolGrantMs), and a billed session must
 * stay listed so its owner can see and stop it. `recordSessionActivity`
 * DELETES it in the same statement that stamps the first accepted turn
 * (projects/session-activity.ts), so "used" and "last active" are one fact
 * written once and cannot drift apart. From that moment the row lists like
 * any other session.
 *
 * Compute placement is matched server-side before reuse or adoption. A
 * server-stamped requested location deduplicates in-flight warming but is
 * never proof of actual placement. Incompatible boxes are abandoned, not moved.
 * There is no advisory lock or unique index; a race between two tabs can cost
 * one extra box, bounded by the reserved concurrent-session slot.
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
