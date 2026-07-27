/**
 * The stall surface: "what is stuck, and why".
 *
 * Two operations over one workspace.
 *
 * {@link resolveWorkspaceLiveness} is a pure read. It is the answer to R-29 —
 * every non-terminal task, with R-28's verdict attached — and it is DERIVED on
 * every call rather than stored. That is what makes it trustworthy: a session
 * that crashes hard, with no hook and no sweep, still shows up here on the very
 * next read, because a dead session's unexpired lease is visible in the rows.
 *
 * {@link sweepWorkspaceLiveness} is the write half, and it is the backstop for
 * exactly that case. It is an EXPLICIT, on-demand, idempotent reconciliation —
 * not a poller, not a queue, not a scheduler (R-21). It runs when someone runs
 * it: the goal's `push` session at the top of its loop (R-11 reads open tasks
 * first anyway), or a human. Calling it twice with unchanged evidence changes
 * nothing the first call did not already do.
 */
import { releaseTask } from '../tasks/store';
import { serializeAgiTask, type AgiTaskRow, type SerializedAgiTask } from '../tasks/wire';
import { applyBoundedRecovery, type BoundedRecoveryResult } from './recovery';
import {
  countChildrenCreatedAfter,
  loadClaimSessionStatuses,
  loadOpenTasks,
  loadRecoveryTasks,
  loadTasksByIds,
  type AgiTaskWithClaimFacts,
} from './store';
import { loadPendingRequestsByTask } from '../requests/store';
import { isLiveRequest, type AgiRequestRow } from '../requests/wire';
import {
  classifyClaimProgress,
  classifyClaimSession,
  isRecoverableStall,
  isStallFingerprint,
  resolveGoalLiveness,
  resolveTaskLiveness,
  serializeGoalLiveness,
  serializeTaskLiveness,
  stallFingerprint,
  type ClaimSessionState,
  type GoalLiveness,
  type PendingRequestRef,
  type SerializedTaskLiveness,
  type TaskLiveness,
} from './wire';
import type { GoalSpec } from '../../projects/lib/agi-goals';
import { METRIC_WINDOW, loadMetricWindows } from '../observations/store';
import {
  resolveFlatStallThreshold,
  rollupGoalMetrics,
  serializeGoalMetric,
  type GoalMetricSummary,
} from '../observations/wire';

/** Whole-workspace bound. See the note on `loadOpenTasks`. */
export const LIVENESS_TASK_CAP = 500;

export interface TaskLivenessView {
  task: AgiTaskWithClaimFacts;
  liveness: TaskLiveness;
}

export interface WorkspaceLiveness {
  views: TaskLivenessView[];
  stalled: TaskLivenessView[];
  truncated: boolean;
}

/**
 * Every open task with its R-28 verdict.
 *
 * Five queries total regardless of task count: the open set, the sessions those
 * tasks' claims name, the rows their `blocked_by` edges point at, the
 * workspace's recovery rows keyed by fingerprint, and the pending human requests
 * attached to those tasks. No per-task round trip, so the surface stays cheap
 * enough to sit on a read route.
 */
export async function resolveWorkspaceLiveness(input: {
  workspaceId: string;
  now?: Date;
  limit?: number;
}): Promise<WorkspaceLiveness> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? LIVENESS_TASK_CAP;
  const tasks = await loadOpenTasks(input.workspaceId, limit);

  const [sessionStatuses, blockerRows, recoveryByFingerprint, requestsByTask] = await Promise.all([
    loadClaimSessionStatuses(uniqueClaimSessionIds(tasks)),
    loadTasksByIds(input.workspaceId, uniqueBlockerIds(tasks)),
    loadRecoveryTasks(input.workspaceId),
    // Spec §4.3. The join is what turns "a human was asked" from prose in a
    // session log into a fact this read model can act on.
    loadPendingRequestsByTask(
      input.workspaceId,
      tasks.map((task) => task.taskId),
    ),
  ]);

  const blockersById = new Map(blockerRows.map((row) => [row.taskId, row]));

  const views = tasks
    // A recovery row is bookkeeping about another task's stall, not work in its
    // own right. Leaving it in would report every stall twice — once on the task
    // and once on the row that exists BECAUSE of that stall.
    .filter((task) => !isStallFingerprint(task.originFingerprint))
    .map((task) => ({
      task,
      liveness: resolveTaskLiveness({
        task,
        now,
        claimSession: claimStateFor(task, sessionStatuses),
        blockers: task.blockedBy
          .map((id) => blockersById.get(id))
          .filter((row): row is AgiTaskRow => row !== undefined),
        recovery: recoveryFor(task, recoveryByFingerprint),
        request: pendingRequestRef(requestsByTask.get(task.taskId)),
      }),
    }));

  return {
    views,
    stalled: views.filter((view) => view.liveness.state === 'stalled'),
    truncated: tasks.length === limit,
  };
}

export interface SweepOutcome {
  taskId: string;
  reason: string;
  /** True when a lease held by an already-terminal session was cleared. */
  claimReleased: boolean;
  progressed: boolean;
  recovery: BoundedRecoveryResult | null;
}

export interface SweepResult {
  scanned: number;
  stalled: number;
  outcomes: SweepOutcome[];
}

/**
 * Reconcile every stalled task in the workspace.
 *
 * Order matters. A stall caused by a dead session's lease is fixed by CLEARING
 * the lease, not by manufacturing new work: once the claim is gone the task may
 * well have a perfectly good live path (its goal's next `push`). So a
 * `claiming_session_terminal` stall is released first and then re-judged, and
 * only a task still stalled afterwards reaches bounded recovery.
 */
export async function sweepWorkspaceLiveness(input: {
  workspaceId: string;
  accountId: string;
  now?: Date;
  limit?: number;
}): Promise<SweepResult> {
  const now = input.now ?? new Date();
  const first = await resolveWorkspaceLiveness({
    workspaceId: input.workspaceId,
    now,
    limit: input.limit,
  });

  const outcomes: SweepOutcome[] = [];
  for (const view of first.stalled) {
    outcomes.push(
      await sweepOne({ view, workspaceId: input.workspaceId, accountId: input.accountId, now }),
    );
  }

  return { scanned: first.views.length, stalled: first.stalled.length, outcomes };
}

async function sweepOne(input: {
  view: TaskLivenessView;
  workspaceId: string;
  accountId: string;
  now: Date;
}): Promise<SweepOutcome> {
  const { workspaceId, accountId, now } = input;
  let task: AgiTaskWithClaimFacts = input.view.task;
  let liveness = input.view.liveness;
  let claimReleased = false;

  // Progress is judged against the claim that is about to be retired, so it must
  // be read while `claimed_at` is still on the row.
  const childrenCreatedAfterClaim = task.claimedAt
    ? await countChildrenCreatedAfter({ workspaceId, taskId: task.taskId, after: task.claimedAt })
    : 0;
  const progress = classifyClaimProgress({
    task,
    writtenSinceClaim: task.writtenSinceClaim,
    childrenCreatedAfterClaim,
  });

  if (liveness.reason === 'claiming_session_terminal' && task.claimSessionId) {
    // R-19 sanctions exactly this: a claim whose session is terminal may be
    // adopted. Holder-scoped, so a claimant that came back to life between the
    // read and here keeps its claim and this matches zero rows.
    const released = await releaseTask({
      workspaceId,
      taskId: task.taskId,
      sessionId: task.claimSessionId,
    });
    claimReleased = released !== null;
    // The release cleared the claim triple, so nothing can have been written
    // since a claim that no longer exists.
    task = released ? { ...released, writtenSinceClaim: false } : task;
    const blockers = await loadTasksByIds(workspaceId, task.blockedBy);
    liveness = resolveTaskLiveness({
      task,
      now,
      claimSession: 'terminal',
      blockers,
      recovery: input.view.liveness.recovery
        ? {
            taskId: input.view.liveness.recovery.taskId,
            assigneeUserId: input.view.liveness.recovery.escalatedTo,
            agent: null,
          }
        : null,
      // Carried from the first pass rather than re-read: releasing a dead lease
      // cannot create, deliver, or answer a human request, so re-querying would
      // be a round trip that can only return what we already have.
      request: input.view.liveness.request,
    });
  }

  // `hadClaim` is read from the PRE-release row: releasing a dead lease is the
  // fix, and it must not also erase the evidence that this task was ever
  // picked up.
  const recoverable =
    liveness.state === 'stalled' &&
    isRecoverableStall({
      reason: liveness.reason,
      hadClaim: input.view.task.claimSessionId !== null,
      hasRecovery: input.view.liveness.recovery !== null,
    });

  if (!recoverable || liveness.reason === null) {
    return {
      taskId: task.taskId,
      reason: liveness.state === 'stalled' ? (liveness.reason ?? liveness.state) : liveness.state,
      claimReleased,
      progressed: progress.progressed,
      recovery: null,
    };
  }

  const recovery = await applyBoundedRecovery({
    workspaceId,
    accountId,
    task,
    reason: liveness.reason,
    evidence: progress.evidence,
    sessionId: input.view.task.claimSessionId,
    observedAt: now,
  });

  return {
    taskId: task.taskId,
    reason: liveness.reason,
    claimReleased,
    progressed: progress.progressed,
    recovery,
  };
}

// ─── R-12e: the goal half of the same surface ───────────────────────────────

export interface GoalLivenessView {
  slug: string;
  title: string;
  status: string;
  metrics: GoalMetricSummary[];
  liveness: GoalLiveness;
}

export interface WorkspaceGoalLiveness {
  views: GoalLivenessView[];
  stalled: GoalLivenessView[];
  /** R-12d's bucket, kept separate from `stalled` on purpose — see
   *  {@link resolveGoalLiveness}. */
  unmeasurable: GoalLivenessView[];
}

/**
 * Every goal in the workspace with its R-12d/R-12e verdict.
 *
 * ONE query regardless of goal count, and the goal specs are passed IN rather
 * than read here: they live in kortix.yaml, the caller has already paid for that
 * git round trip to answer its own question, and re-reading the manifest inside
 * a liveness pass would make one HTTP request clone the repo twice.
 */
export async function resolveWorkspaceGoalLiveness(input: {
  workspaceId: string;
  goals: readonly Pick<GoalSpec, 'slug' | 'title' | 'status' | 'doneWhen'>[];
  flatStallAfter?: number;
}): Promise<WorkspaceGoalLiveness> {
  const flatStallAfter = input.flatStallAfter ?? resolveFlatStallThreshold();
  const windows = await loadMetricWindows(
    input.workspaceId,
    input.goals.map((goal) => goal.slug),
  );
  const byGoal = rollupGoalMetrics(windows, METRIC_WINDOW);

  const views = input.goals.map((goal) => {
    const metrics = byGoal.get(goal.slug) ?? [];
    return {
      slug: goal.slug,
      title: goal.title,
      status: goal.status,
      metrics,
      liveness: resolveGoalLiveness({
        status: goal.status,
        doneWhen: goal.doneWhen,
        metrics,
        flatStallAfter,
      }),
    };
  });

  return {
    views,
    stalled: views.filter((view) => view.liveness.state === 'stalled'),
    unmeasurable: views.filter((view) => view.liveness.state === 'unmeasurable'),
  };
}

export function serializeGoalLivenessView(view: GoalLivenessView) {
  return {
    slug: view.slug,
    title: view.title,
    status: view.status,
    liveness: serializeGoalLiveness(view.liveness),
    metrics: view.metrics.map(serializeGoalMetric),
  };
}

// ─── serialization ──────────────────────────────────────────────────────────

export interface SerializedTaskLivenessView {
  task: SerializedAgiTask;
  liveness: SerializedTaskLiveness;
}

export function serializeLivenessView(
  view: TaskLivenessView,
  now: Date,
): SerializedTaskLivenessView {
  return { task: serializeAgiTask(view.task, now), liveness: serializeTaskLiveness(view.liveness) };
}

export function serializeSweepOutcome(outcome: SweepOutcome) {
  return {
    task_id: outcome.taskId,
    reason: outcome.reason,
    claim_released: outcome.claimReleased,
    progressed: outcome.progressed,
    recovery: outcome.recovery
      ? {
          step: outcome.recovery.step,
          fingerprint: outcome.recovery.fingerprint,
          task_id: outcome.recovery.recoveryTaskId,
          escalated_to: outcome.recovery.escalatedTo,
        }
      : null,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function uniqueClaimSessionIds(tasks: readonly AgiTaskRow[]): string[] {
  const ids = new Set<string>();
  for (const task of tasks) if (task.claimSessionId) ids.add(task.claimSessionId);
  return [...ids];
}

function uniqueBlockerIds(tasks: readonly AgiTaskRow[]): string[] {
  const ids = new Set<string>();
  for (const task of tasks) for (const id of task.blockedBy) ids.add(id);
  return [...ids];
}

function claimStateFor(task: AgiTaskRow, statuses: Map<string, string>): ClaimSessionState {
  if (!task.claimSessionId) return 'unknown';
  return classifyClaimSession(statuses.get(task.claimSessionId) ?? null);
}

/**
 * The recovery row this task's stall would have produced, if it exists.
 *
 * The fingerprint is recomputed from the CURRENT row, which is the point: if the
 * task's status has since changed, the stalled state is a different one and its
 * old recovery row is correctly not attached to it.
 */
/**
 * Row → the minimal shape liveness reasons over.
 *
 * `delivered` is computed by `isLiveRequest` in requests/wire.ts and nowhere
 * else, so R-12g's line is drawn in exactly one place. The row arriving here is
 * already known to be pending (the store filters on it), but the predicate
 * re-checks anyway — a caller that widened the query later must not silently
 * turn a satisfied ask back into a live path.
 */
function pendingRequestRef(row: AgiRequestRow | undefined): PendingRequestRef | null {
  if (!row) return null;
  return {
    requestId: row.requestId,
    kind: row.kind,
    need: row.need,
    responderUserId: row.responderUserId,
    delivered: isLiveRequest(row),
    deliveredVia: row.deliveredVia,
  };
}

function recoveryFor(task: AgiTaskRow, byFingerprint: Map<string, AgiTaskRow>): AgiTaskRow | null {
  for (const reason of [
    'claiming_session_terminal',
    'claim_expired',
    'dead_blocker',
    'no_live_path',
  ] as const) {
    const found = byFingerprint.get(
      stallFingerprint({ taskId: task.taskId, taskStatus: task.status, reason }),
    );
    if (found) return found;
  }
  return null;
}
