/**
 * TWO FORCED MIRROR REFRESHES A SECOND APART ARE ONE OBSERVATION.
 *
 * `refreshMirror(project, force=true)` means "do not serve me the 60-second TTL
 * copy". It has never meant "perform a network round trip once per caller", but
 * that is what it did, and the platform has several forced readers that run
 * within the same flow:
 *
 *   projects/lib/sessions.ts        loadProjectAgents, at session create
 *   projects/lib/session-token-grant.ts  remintGrant, on every prompt delivery
 *
 * MEASURED on dev 2026-09-09, inside the API container, authenticated exactly
 * as the API authenticates (timings only, four runs):
 *
 *   git --version (spawn only)     9 / 7 / 4 / 3 ms
 *   git ls-remote origin main    538 / 461 / 471 / 484 ms
 *   git fetch --prune origin     487 / 523 / 499 / 450 ms
 *
 * The whole half-second is one authenticated round trip to GitHub. `ls-remote`
 * costs the same as `fetch`, so "check cheaply, then fetch" saves nothing —
 * measured, after an earlier attempt at that idea timed UNAUTHENTICATED
 * failures (`could not read Username`) and made the check look twice as cheap
 * as it is.
 *
 * So the only thing left to remove is the repetition. A forced refresh that
 * finished a moment ago is as fresh as one starting now: the remote cannot
 * meaningfully have moved, and any window here is still far tighter than the
 * TTL `force` exists to bypass.
 *
 * OFF BY DEFAULT (`KORTIX_GIT_FORCE_COALESCE_MS`, 0 = every force fetches).
 * It weakens `force`, and by how much is a deployment's decision.
 */

export type ForcedRefreshPlan =
  /** A forced refresh finished inside the window; reuse it. */
  | 'reuse_recent_force'
  /** Do the round trip. */
  | 'fetch';

export interface ForcedRefreshInput {
  /** ms since the last COMPLETED forced refresh for this project. */
  sinceLastForcedMs: number;
  /** The window; 0 or less disables coalescing entirely. */
  windowMs: number;
}

/**
 * Pure, so the window is asserted rather than raced against a git remote.
 *
 * Fails toward fetching: an unknown or unreadable age does the round trip,
 * because the cost of an extra fetch is half a second and the cost of wrongly
 * reusing is a stale answer to a caller that explicitly asked not to have one.
 */
export function planForcedRefresh(input: ForcedRefreshInput): ForcedRefreshPlan {
  if (!Number.isFinite(input.windowMs) || input.windowMs <= 0) return 'fetch';
  if (!Number.isFinite(input.sinceLastForcedMs) || input.sinceLastForcedMs < 0) return 'fetch';
  return input.sinceLastForcedMs < input.windowMs ? 'reuse_recent_force' : 'fetch';
}
