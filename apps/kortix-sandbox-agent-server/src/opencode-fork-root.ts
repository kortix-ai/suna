/**
 * Warm-fork opencode-root de-collision (pure logic, separated from main.ts so it
 * is unit-testable — main.ts self-executes on import).
 *
 * A warm sandbox is CoW-forked from a snapshot that booted opencode, created ONE
 * root session, and pinned it (OPENCODE_SESSION_PIN_PATH) so forks resume warm
 * without paying opencode's first-session project init. The catch: every fork
 * inherits the SAME pinned root id from that one snapshot.
 *
 * The client keys ALL session state — messages, parts, status — purely by
 * opencode session id (it assumes ids are unique per sandbox). So if forks adopt
 * the shared seed root, every session resolves the same id and their chats bleed
 * into one another: "switch sessions, see the same thread everywhere".
 *
 * Fix: the seed records the baked id in a marker file that is captured into the
 * snapshot. A fork reads it to rotate onto its OWN fresh root EXACTLY ONCE,
 * instead of reusing the shared seed root, then retires the marker so later
 * daemon restarts reuse the fork's own root via the normal idempotent path.
 */

/** Well-known marker recording the SEED's pre-baked root id. Lives next to
 *  OPENCODE_SESSION_PIN_PATH and is frozen into the warm snapshot, so every fork
 *  inherits it. Absent on cold sessions and after a fork has rotated. */
export const OPENCODE_SEED_BAKED_PIN_PATH = '/var/run/kortix/opencode-seed-baked-id'

/**
 * True when the fork's currently-resolved root is the shared seed-baked root and
 * must NOT be reused — the caller then mints a fresh per-session root instead.
 *
 * False (reuse as normal) when:
 *   • there is no existing root (the caller creates one anyway),
 *   • there is no seed marker (a cold session, or a fork that already rotated), or
 *   • the existing root differs from the seed id (it is already the fork's own).
 */
export function isSharedSeedBakedRoot(
  existingRootId: string | null | undefined,
  seedBakedId: string | null | undefined,
): boolean {
  return !!existingRootId && !!seedBakedId && existingRootId === seedBakedId
}
