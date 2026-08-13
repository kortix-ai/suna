/**
 * Resume-decision helpers for the session view.
 *
 * On the first `/start` of an idle-stopped session the backend can hand back a
 * TERMINAL stage with a non-null sandbox whose row is left EXACTLY resumable
 * (`status: 'stopped'` + an `external_id`) — see `openSession`'s self-preserve
 * path. A hard refresh's fresh `/start` then hits the resume path and wakes the
 * box. These helpers let the page recognize that state so it can auto-resume
 * (re-issue `/start`) instead of pinning a dead-end "open a new session" card.
 */

/** The subset of the `/start` sandbox payload the resume decision needs. */
export interface ResumableSandboxLike {
  status?: string | null;
  external_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * The server has proven this runtime is gone and preserved its identity rather
 * than silently handing the session a fresh, empty box.
 *
 * This is the ONE terminal identity state. `recovering` / `recovery_claimed` /
 * `recovered` all describe a same-id restore that is still in flight, and those
 * must keep resuming normally.
 */
export function isRuntimeIdentityUnavailable(
  sandbox: ResumableSandboxLike | null | undefined,
): boolean {
  const metadata = sandbox?.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as Record<string, unknown>).runtimeIdentityState === 'unavailable';
}

/**
 * A hibernated box is still resumable when its row is `stopped` AND it kept an
 * `external_id` — a fresh `/start` wakes it in place (keeps its disk/workspace).
 * A stopped row with no `external_id` is genuinely gone and not resumable.
 *
 * A PRESERVED-UNAVAILABLE row is the trap those two fields cannot see. When the
 * provider loses a box, `openSession` deliberately keeps the row `stopped` WITH
 * its `external_id` — that is what "the identity was preserved, and no
 * replacement sandbox was created" means. Reading only status + external_id
 * therefore called a permanently dead runtime resumable, and the page spent its
 * whole auto-resume budget re-issuing `/start` against it (prod session
 * ad4b63ac, 2026-08-13) before landing on a Restart button that can only 409.
 */
export function isSandboxResumable(sandbox: ResumableSandboxLike | null | undefined): boolean {
  if (isRuntimeIdentityUnavailable(sandbox)) return false;
  return !!sandbox && sandbox.status === 'stopped' && !!sandbox.external_id;
}

/**
 * While auto-resume attempts remain, a resumable box is "waking", not "dead" —
 * the page shows the boot loader rather than the terminal card. Once attempts are
 * exhausted it falls through to a manual Restart.
 */
export function isAutoResuming(
  sandbox: ResumableSandboxLike | null | undefined,
  attempts: number,
  maxAttempts: number,
): boolean {
  return isSandboxResumable(sandbox) && attempts < maxAttempts;
}
