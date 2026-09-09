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
  /**
   * ms since the last turn ENDED for this project, or null when no turn end has
   * been observed in this process.
   *
   * A CLOCK IS THE WRONG UNIT FOR THIS QUESTION. What `force` protects is a
   * `kortix.yaml` that an agent narrowed DURING A TURN, and a turn is the only
   * thing in a session that can narrow it. So a forced refresh taken after the
   * last turn ended is still exactly as current as one taken now, however long
   * ago it was — nothing that this deployment runs has happened in between.
   *
   * Measured on dev 2026-09-09: with the 60 s window alone, a reply 75 s after
   * the previous one paid `remintGrant: 534 ms` again, for a manifest that
   * could not have moved.
   */
  sinceLastTurnEndMs: number | null;
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
  // A refresh taken AFTER the last turn ended already answers this caller. The
  // turn-end warm-up (turn-end-mirror-warmup.ts) is what makes this the common
  // case: it fetches while the user reads the answer, so the next prompt — at
  // any distance — finds the work done.
  //
  // `>` and not `>=`: equal stamps mean the two events landed in the same
  // millisecond and the order is unknown, and an unknown order here has to fall
  // toward fetching.
  const { sinceLastTurnEndMs: sinceTurnEnd, sinceLastForcedMs: sinceForce } = input;
  if (
    sinceTurnEnd !== null &&
    Number.isFinite(sinceTurnEnd) &&
    sinceTurnEnd >= 0 &&
    sinceTurnEnd > sinceForce
  ) {
    return 'reuse_recent_force';
  }
  return sinceLastForcedIsInsideWindow(sinceForce, input.windowMs);
}

/** The original clock window, kept as the fallback for a project this process
 *  has seen no turn end for — a fresh pod, or the first turn of a session. */
function sinceLastForcedIsInsideWindow(sinceLastForcedMs: number, windowMs: number): ForcedRefreshPlan {
  return sinceLastForcedMs < windowMs ? 'reuse_recent_force' : 'fetch';
}
