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
}

/**
 * A hibernated box is still resumable when its row is `stopped` AND it kept an
 * `external_id` — a fresh `/start` wakes it in place (keeps its disk/workspace).
 * A stopped row with no `external_id` is genuinely gone and not resumable.
 */
export function isSandboxResumable(sandbox: ResumableSandboxLike | null | undefined): boolean {
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
