/**
 * R-32 — bounded recovery.
 *
 * Exactly one automatic continuation per stalled state, then escalation to a
 * human, then silence. Ownership never moves to a different agent.
 *
 * WHY THIS IS NOT A SCHEDULER
 *
 * R-21 allows exactly one mechanism to start work without a human: the existing
 * trigger subsystem. So recovery does not start anything. It creates a TASK — the
 * continuation — owned by the same agent, under the same goal, and then stops.
 * What picks that task up is the goal's standing `push` (R-8: one cron trigger in
 * the existing subsystem) or the trigger lineage the stalled task already had, on
 * its next fire. That is R-24's deliberate trade: a stall found at 03:00 is worked
 * at the next push rather than immediately, and in exchange there is no wake
 * queue, no heartbeat, and no second path to keep correct.
 *
 * The consequence is worth stating plainly rather than hiding: a stalled task
 * with no goal and no trigger lineage has NOTHING that will pick its continuation
 * up either. Recovery still records it — and {@link resolveTaskLiveness} still
 * reports both rows as stalled — because R-29 wants that surfaced, not retried.
 *
 * WHY THE BOUND IS AN INDEX AND NOT A COUNTER
 *
 * The continuation is inserted with `origin_fingerprint = stallFingerprint(...)`.
 * The partial unique index on (workspace_id, origin_fingerprint) is what makes
 * "at most one" true: a second attempt with identical evidence loses the INSERT
 * and comes back `created: false`. Nothing reads a counter, so nothing can drift,
 * and two concurrent sweeps produce one row rather than two.
 */
import { createTask } from '../tasks/store';
import type { AgiTaskRow } from '../tasks/wire';
import {
  continuationBody,
  continuationTitle,
  nextRecoveryStep,
  stallFingerprint,
  type ProgressEvidence,
  type RecoveryStep,
  type StallReason,
} from './wire';
import {
  escalateRecoveryTask,
  loadAccountOwner,
  loadRecoveryTask,
  loadRecoveryTaskAssignee,
} from './store';

export interface BoundedRecoveryInput {
  workspaceId: string;
  accountId: string;
  /** The stalled task. Never mutated — recovery is not a control-plane act on
   *  someone else's work (R-31), and re-statusing it would destroy the very
   *  evidence the fingerprint is derived from. */
  task: AgiTaskRow;
  reason: StallReason;
  evidence: ProgressEvidence;
  /** The claim holder at the time the stall was observed. Evidence only — it is
   *  deliberately absent from the fingerprint (see {@link stallFingerprint}). */
  sessionId: string | null;
  observedAt: Date;
}

export interface BoundedRecoveryResult {
  taskId: string;
  fingerprint: string;
  step: RecoveryStep;
  /** The continuation row, or null when escalation had no human to hand it to. */
  recoveryTaskId: string | null;
  escalatedTo: string | null;
}

export async function applyBoundedRecovery(
  input: BoundedRecoveryInput,
): Promise<BoundedRecoveryResult> {
  const fingerprint = stallFingerprint({
    taskId: input.task.taskId,
    taskStatus: input.task.status,
    reason: input.reason,
  });

  const existing = await loadRecoveryTask({ workspaceId: input.workspaceId, fingerprint });

  if (!existing) {
    // R-14/R-32: the continuation inherits the stalled task's assignee verbatim.
    // A task assigned to a human stays with that human; an agent's work stays
    // with that agent. Nothing here can hand work to a DIFFERENT agent, because
    // no branch ever writes an agent name this function did not read.
    const { row, created } = await createTask({
      workspaceId: input.workspaceId,
      title: continuationTitle(input.task.title),
      body: continuationBody({
        taskId: input.task.taskId,
        reason: input.reason,
        evidence: input.evidence,
        sessionId: input.sessionId,
        observedAt: input.observedAt,
      }),
      goalSlug: input.task.goalSlug,
      project: input.task.project,
      parentId: input.task.taskId,
      status: 'todo',
      priority: 'high',
      agent: input.task.agent,
      assigneeUserId: input.task.agent === null ? input.task.assigneeUserId : null,
      blockedBy: [],
      triggerSlug: input.task.triggerSlug,
      origin: 'session',
      originFingerprint: fingerprint,
    });

    // `created: false` means a concurrent observer won the insert. Their row IS
    // the one continuation, so this caller has nothing left to do — falling
    // through to escalate would turn a race into a spurious human ping.
    return {
      taskId: input.task.taskId,
      fingerprint,
      step: created ? 'continued' : 'already_escalated',
      recoveryTaskId: row.taskId,
      escalatedTo: row.assigneeUserId,
    };
  }

  // A row already exists, so this stalled state has had its one continuation.
  if (nextRecoveryStep(existing) === 'already_escalated') {
    return {
      taskId: input.task.taskId,
      fingerprint,
      step: 'already_escalated',
      recoveryTaskId: existing.taskId,
      escalatedTo: existing.assigneeUserId,
    };
  }

  // The same stalled state was observed a second time. Stop continuing and hand
  // it to a human, with the cause and evidence the continuation already carries.
  const owner = await loadAccountOwner(input.accountId);
  if (!owner) {
    // No owner to escalate to. Leave the continuation exactly as it is: it stays
    // visible on the stall surface, which is the outcome R-29 asks for anyway.
    return {
      taskId: input.task.taskId,
      fingerprint,
      step: 'escalated',
      recoveryTaskId: existing.taskId,
      escalatedTo: null,
    };
  }

  const escalated = await escalateRecoveryTask({
    workspaceId: input.workspaceId,
    taskId: existing.taskId,
    assigneeUserId: owner,
    title: continuationTitle(input.task.title, true),
  });

  // Zero rows back means a concurrent sweep escalated first — same end state,
  // reported honestly rather than as a second escalation. Read who actually
  // holds it rather than naming `owner`, which would report a human who may
  // never have been assigned.
  const escalatedTo = escalated
    ? escalated.assigneeUserId
    : await loadRecoveryTaskAssignee({ workspaceId: input.workspaceId, taskId: existing.taskId });

  return {
    taskId: input.task.taskId,
    fingerprint,
    step: escalated ? 'escalated' : 'already_escalated',
    recoveryTaskId: existing.taskId,
    escalatedTo,
  };
}
