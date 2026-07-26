/**
 * R-33 — the session → task writeback.
 *
 * This is the hook the session-lifecycle terminal paths call. Everything it does
 * is decided from rows; it starts nothing, waits for nothing, and is safe to
 * fire-and-forget from a request path.
 *
 * WHAT A SESSION ENDING DOES AND DOES NOT MEAN
 *
 * It does NOT mean the task is done. R-31 is explicit that prose is not a status
 * change, and a session exiting is the same class of non-event: the only thing
 * that marks a task done is an explicit status change through the task surface.
 * So this never writes a task status. What it writes is:
 *
 *   1. the claim, released — R-19 says a claim whose session is terminal MAY be
 *      adopted, and holding a dead lease is precisely what makes the next `push`
 *      lose a claim it should have won. The release is holder-scoped (the same
 *      `claim_session_id` this session took), so it can never break a live
 *      claimant;
 *   2. the progress determination, on the session, for every claim it held;
 *   3. one bounded continuation (R-32), but only for a task that has no live
 *      path left once the dead claim is gone.
 *
 * Step 3's condition matters. A task under a goal still has the goal's standing
 * `push` waiting for it (R-28 answer 2) — the claim was the only thing in its
 * way, and clearing it is the whole fix. Manufacturing a continuation for it as
 * well would be noise that a human has to triage.
 */
import { resolveExperimentalFeature } from '../../experimental/features';
import { releaseTask } from '../tasks/store';
import type { AgiTaskRow } from '../tasks/wire';
import { applyBoundedRecovery } from './recovery';
import {
  countChildrenCreatedAfter,
  loadSession,
  loadTasksByIds,
  loadTasksClaimedBySession,
  loadWorkspace,
  recordSessionLivenessOutcome,
  type AgiTaskWithClaimFacts,
} from './store';
import {
  classifyClaimProgress,
  classifyClaimSession,
  isRecoverableStall,
  resolveTaskLiveness,
  type LivenessState,
  type ProgressEvidence,
  type RecoveryStep,
} from './wire';

export interface SessionClaimOutcome {
  taskId: string;
  progressed: boolean;
  evidence: ProgressEvidence;
  /** Liveness AFTER the dead claim was released — the state a reader will see. */
  state: LivenessState;
  recovery: RecoveryStep | null;
}

export interface SessionOutcome {
  sessionId: string;
  /** Why nothing was written. `null` when the writeback ran. */
  skipped:
    | 'unknown_session'
    | 'session_not_terminal'
    | 'unknown_workspace'
    | 'agi_disabled'
    | 'no_claims'
    | null;
  claims: SessionClaimOutcome[];
}

/**
 * Record what a terminating session did to the tasks it claimed.
 *
 * Idempotent: a second call re-derives the same determination, re-releases
 * nothing (the claim is already gone, and the holder-scoped predicate matches
 * zero rows), and re-runs recovery into the same fingerprint. Callers may
 * therefore invoke it from every terminal path without coordinating.
 */
export async function recordSessionOutcome(input: {
  sessionId: string;
  /** Optional, purely to skip a lookup — the session row is authoritative. */
  now?: Date;
}): Promise<SessionOutcome> {
  const now = input.now ?? new Date();
  const empty = (skipped: SessionOutcome['skipped']): SessionOutcome => ({
    sessionId: input.sessionId,
    skipped,
    claims: [],
  });

  const session = await loadSession(input.sessionId);
  if (!session) return empty('unknown_session');
  // The one hard precondition. Everything below RELEASES claims, and R-19 says a
  // claim held by a live session must not be broken — so a caller that fires
  // this before the status flip (or on the wrong session) has to be a no-op, not
  // a stolen lease. The status is re-read here rather than taken as a parameter
  // precisely so a caller cannot assert termination that has not happened.
  if (classifyClaimSession(session.status) !== 'terminal') return empty('session_not_terminal');

  const workspace = await loadWorkspace(session.projectId);
  if (!workspace) return empty('unknown_workspace');
  // R-44: with `agi` off there is no surface at all, so there is nothing to
  // write back. Checked here rather than at the call sites so a new terminal
  // path cannot forget it.
  if (!resolveExperimentalFeature(workspace.metadata, 'agi')) return empty('agi_disabled');

  const claimed = await loadTasksClaimedBySession({
    workspaceId: session.projectId,
    sessionId: input.sessionId,
  });
  if (claimed.length === 0) return empty('no_claims');

  const claims: SessionClaimOutcome[] = [];
  for (const task of claimed) {
    claims.push(
      await settleClaim({
        task,
        workspaceId: session.projectId,
        accountId: session.accountId,
        sessionId: input.sessionId,
        now,
      }),
    );
  }

  await recordSessionLivenessOutcome({
    sessionId: input.sessionId,
    outcome: {
      recorded_at: now.toISOString(),
      session_status: session.status,
      // R-33's "MUST be visible": the count is the number a human scans for.
      no_progress_count: claims.filter((claim) => !claim.progressed).length,
      claims: claims.map((claim) => ({
        task_id: claim.taskId,
        progressed: claim.progressed,
        evidence: claim.evidence,
        state: claim.state,
        recovery: claim.recovery,
      })),
    },
  });

  return { sessionId: input.sessionId, skipped: null, claims };
}

async function settleClaim(input: {
  task: AgiTaskWithClaimFacts;
  workspaceId: string;
  accountId: string;
  sessionId: string;
  now: Date;
}): Promise<SessionClaimOutcome> {
  const { task, workspaceId, accountId, sessionId, now } = input;

  // Determined BEFORE the release, because `claimed_at` is the reference point
  // the whole test is built on and releasing clears it.
  const childrenCreatedAfterClaim = task.claimedAt
    ? await countChildrenCreatedAfter({ workspaceId, taskId: task.taskId, after: task.claimedAt })
    : 0;
  const progress = classifyClaimProgress({
    task,
    writtenSinceClaim: task.writtenSinceClaim,
    childrenCreatedAfterClaim,
  });

  await releaseTask({ workspaceId, taskId: task.taskId, sessionId });

  // The row as a reader will now see it. Re-reading would be a wasted round trip
  // and would race a concurrent claimant into a wrong answer; the release's
  // effect on this row is fully known.
  const released: AgiTaskRow = {
    ...task,
    claimSessionId: null,
    claimedAt: null,
    claimExpiresAt: null,
  };
  const blockers = await loadTasksByIds(workspaceId, released.blockedBy);
  const liveness = resolveTaskLiveness({
    task: released,
    now,
    claimSession: 'terminal',
    blockers,
    recovery: null,
  });

  // `hadClaim` is unconditionally true here — these rows were found BY this
  // session's claim — but the predicate is applied rather than assumed so the
  // hook and the sweep can never diverge on what recovery is for.
  const recoverable =
    liveness.state === 'stalled' &&
    isRecoverableStall({ reason: liveness.reason, hadClaim: true, hasRecovery: false });

  if (!recoverable || liveness.reason === null) {
    return {
      taskId: task.taskId,
      progressed: progress.progressed,
      evidence: progress.evidence,
      state: liveness.state,
      recovery: null,
    };
  }

  const recovery = await applyBoundedRecovery({
    workspaceId,
    accountId,
    task: released,
    reason: liveness.reason,
    evidence: progress.evidence,
    sessionId,
    observedAt: now,
  });

  return {
    taskId: task.taskId,
    progressed: progress.progressed,
    evidence: progress.evidence,
    state: liveness.state,
    recovery: recovery.step,
  };
}

/**
 * The fire-and-forget form for the session-lifecycle terminal paths.
 *
 * A liveness failure must never fail a stop, a delete, or a dead-letter — those
 * have already done the thing the caller asked for by the time this runs. It
 * logs and swallows, deliberately: the sweep (POST .../agi/liveness/sweep) is the
 * backstop, and it re-derives everything this call would have written.
 */
export function recordSessionOutcomeBestEffort(sessionId: string): void {
  void recordSessionOutcome({ sessionId }).catch((err) => {
    console.warn('[agi-liveness] session outcome writeback failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
