/**
 * Goals: the server gate on every automatic wake, and successor adoption.
 *
 * Every reminder fire asks `admitGoalWake` first (`lib/trigger-fire.ts`
 * `fireSessionReminder`). A reminder that is no goal's heartbeat passes
 * untouched. A goal heartbeat is decided on the locked goal row: flag, state,
 * pause and the per-UTC-day wake cap, then billing. A refusal runs no turn,
 * writes `wake_refused` and heals the heartbeat (off, or moved to the next UTC
 * midnight for the cap). An admit counts the wake once per idempotency key
 * and writes `wake_admitted`.
 */
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { logger } from '../../lib/logger';
import type { ProjectRow } from '../lib/serializers';
import { rescheduleHeartbeat, setHeartbeatEnabled } from './effects';
import { notifyGoal } from './notify';
import { decideWake, nextUtcMidnight, type WakeDecision } from './rules';
import { GoalError, goalByHeartbeat, goalFlagOn, goalOfSession, setGoalRuntimeFields, writeGoal, type GoalRow } from './store';

export type GoalWakeVerdict =
  | { goal: null }
  | { goal: GoalRow; admitted: true }
  | { goal: GoalRow; admitted: false; reason: string };

const PLATFORM = { actorKind: 'platform' as const, actorId: null };

/**
 * The gate. `idempotencyKey` is the delivery key of the fire (one per due
 * slot, or `goal-event:<goal>:<source>:<id>` for an event wake): a retried
 * delivery is admitted again without counting twice.
 */
export async function admitGoalWake(input: {
  project: ProjectRow;
  goal: GoalRow;
  idempotencyKey: string | null;
  source: string;
  now?: Date;
}): Promise<Exclude<GoalWakeVerdict, { goal: null }>> {
  const { project, goal } = input;
  const flagOn = resolveFeatureFlag(project.metadata, 'goals');
  let decision: WakeDecision | null = null;
  let billingRefusal: string | null = null;
  if (flagOn) {
    const billing = await checkBillingAdmission(project.accountId);
    if (!billing.ok) billingRefusal = billing.message;
  }
  const key = input.idempotencyKey;
  let result;
  try {
    result = await writeGoal(project.projectId, goal.goalId, (row, now) => {
      decision = decideWake(row, { now, flagOn });
      if (decision.admit && billingRefusal) {
        return {
          patch: { blockedReason: 'credits' },
          keepRevision: true,
          event: { ...PLATFORM, kind: 'wake_refused', message: `Wake refused: no credits. ${billingRefusal}`.slice(0, 500), data: { reason: 'credits', source: input.source }, dedupeKey: key ? `${key}:refused` : null },
        };
      }
      if (!decision.admit) {
        const reason = decision.reason;
        return {
          patch: {
            ...(reason === 'flag_off' ? { blockedReason: 'flag_off' as const } : {}),
            ...(reason === 'wake_cap' ? { blockedReason: 'wake_cap' as const, wakeDay: decision.wakeDay, wakesToday: decision.wakesToday } : {}),
          },
          keepRevision: true,
          event: { ...PLATFORM, kind: 'wake_refused', message: `Wake refused: ${reason}.`, data: { reason, source: input.source }, dedupeKey: key ? `${key}:refused` : null },
        };
      }
      return {
        patch: {
          wakeDay: decision.wakeDay,
          wakesToday: decision.wakesToday,
          lastWakeAt: now,
          ...(decision.chase ? { chaseAt: null } : {}),
          // The cap of a past day no longer holds.
          ...(row.blockedReason === 'wake_cap' || row.blockedReason === 'credits' ? { blockedReason: null } : {}),
        },
        keepRevision: true,
        event: { ...PLATFORM, kind: 'wake_admitted', message: decision.chase ? 'Woke to chase the open question.' : 'Wake admitted.', data: { source: input.source, wakes_today: decision.wakesToday }, dedupeKey: key },
      };
    }, { now: input.now });
  } catch (error) {
    if (error instanceof GoalError && error.status === 404) return { goal, admitted: false, reason: 'goal_gone' };
    throw error;
  }
  const decided = decision as WakeDecision | null;
  const row = result.row;
  // A retried delivery whose admit already counted.
  if (result.deduped && decided?.admit && !billingRefusal) return { goal: row, admitted: true };
  if (decided?.admit && !billingRefusal) return { goal: row, admitted: true };
  const reason = billingRefusal && decided?.admit ? 'credits' : decided && !decided.admit ? decided.reason : 'refused';
  await healRefusedHeartbeat(row, reason, input.now ?? new Date());
  return { goal: row, admitted: false, reason };
}

async function healRefusedHeartbeat(goal: GoalRow, reason: string, now: Date): Promise<void> {
  const id = goal.heartbeatReminderId;
  try {
    if (reason === 'wake_cap') {
      if (id) {
        const at = nextUtcMidnight(now, goal.goalId);
        await rescheduleHeartbeat(goal.projectId, id, at, now);
        await setGoalRuntimeFields(goal.goalId, { nextWakeAt: at });
      }
      return;
    }
    if (reason === 'credits') {
      await notifyGoal(goal, 'blocked', 'A wake was refused: the account has no credits. Top up, then resume the goal.', now);
      return;
    }
    // Flag off, paused, closed, waiting without a due chase: the heartbeat stays off until a person or the owner moves the goal.
    if (id) {
      await setHeartbeatEnabled(goal.projectId, id, false, now);
      await setGoalRuntimeFields(goal.goalId, { nextWakeAt: null });
    }
  } catch (error) {
    logger.warn('[goals] heartbeat heal after a refused wake failed', { goal_id: goal.goalId, reason, error: error instanceof Error ? error.message : String(error) });
  }
}

/** The gate for one reminder fire: `{ goal: null }` when the reminder is no goal's heartbeat. */
export async function admitReminderFire(input: { project: ProjectRow; reminderId: string; idempotencyKey: string | null; source: string }): Promise<GoalWakeVerdict> {
  const goal = await goalByHeartbeat(input.project.projectId, input.reminderId);
  if (!goal) return { goal: null };
  return admitGoalWake({ project: input.project, goal, idempotencyKey: input.idempotencyKey, source: input.source });
}

/**
 * A goal heartbeat's owner session failed: may a successor start? False (and
 * the goal blocked `session_cap`) when the goal used all its sessions.
 */
export async function goalSuccessorAllowed(projectId: string, reminderId: string): Promise<{ goal: GoalRow | null; allowed: boolean }> {
  const goal = await goalByHeartbeat(projectId, reminderId);
  if (!goal) return { goal: null, allowed: true };
  if (goal.sessions.length < goal.maxSessions) return { goal, allowed: true };
  const blocked = await writeGoal(projectId, goal.goalId, (row) =>
    row.blockedReason === 'session_cap'
      ? { unchanged: true }
      : { patch: { blockedReason: 'session_cap' }, keepRevision: true, event: { ...PLATFORM, kind: 'blocked', message: 'The owner session failed and the goal has no session left for a successor.', data: { reason: 'session_cap' } } },
  );
  await notifyGoal(blocked.row, 'blocked', 'Its owner session failed and it has used every session it may. Raise the session cap, then resume it.', new Date());
  return { goal: blocked.row, allowed: false };
}

/** The session metadata a goal successor carries, so its box knows the goal and its role. */
export function goalSuccessorMetadata(goal: GoalRow): Record<string, unknown> {
  return { unattended: 'true', goal_id: goal.goalId, goal: goal.boxFolder, goal_role: 'owner' };
}

/**
 * A successor session took over a failed owner's heartbeat (the reminder was
 * repinned to it): it becomes the goal's owner. Runs in the successor's
 * post-create step (`session-lifecycle/create-session.ts`). Idempotent: a
 * goal already owned by the successor changes nothing.
 */
export async function adoptGoalSuccessor(projectId: string, reminderId: string, successorSessionId: string): Promise<GoalRow | null> {
  const goal = await goalByHeartbeat(projectId, reminderId);
  if (!goal || goal.ownerSessionId === successorSessionId) return goal;
  const result = await writeGoal(projectId, goal.goalId, (row, now) =>
    row.ownerSessionId === successorSessionId
      ? { unchanged: true }
      : {
          patch: {
            ownerSessionId: successorSessionId,
            sessions: [...row.sessions, { id: successorSessionId, role: 'owner', since: now.toISOString() }],
            ...(row.blockedReason === 'owner_lost' ? { blockedReason: null } : {}),
          },
          bumpGeneration: true,
          event: { ...PLATFORM, kind: 'owner_adopted', message: 'A successor session took over from the failed owner session.', data: { from: row.ownerSessionId, to: successorSessionId } },
        },
  );
  return result.row;
}

/** The open goal a session works on (owner or verifier), by the session id: never by folder string. */
export async function goalForSession(sessionId: string): Promise<GoalRow | null> {
  return goalOfSession(sessionId);
}

/**
 * A session credential may not pause, edit, run or delete its own goal's
 * heartbeat through the reminder routes: that is how an owner paused itself
 * (G05). The API alone changes it. Returns the refusal line, or null.
 */
export async function goalHeartbeatEditRefusal(projectId: string, reminderId: string, sessionCaller: boolean): Promise<string | null> {
  if (!sessionCaller) return null;
  const goal = await goalByHeartbeat(projectId, reminderId);
  return goal ? `This loop is the heartbeat of goal ${goal.goalId}. Only the Kortix API changes it; a person pauses or stops the goal.` : null;
}

/**
 * Why a goal prompt queued into `sessionId` must not run now, or null. A prompt
 * the engine queued before a person paused or stopped the goal waits in the
 * session inbox; it is refused at delivery, so no turn starts after the control.
 */
export async function goalPromptRefusal(sessionId: string): Promise<string | null> {
  const goal = await goalOfSession(sessionId);
  if (!goal) return null;
  if (goal.state === 'done' || goal.state === 'stopped') return `The goal is ${goal.state}: its queued prompt does not run.`;
  if (goal.pausedAt) return 'A person paused the goal: its queued prompt does not run.';
  if (!(await goalFlagOn(goal.projectId))) return 'Goals is turned off for this project: its queued prompt does not run.';
  return null;
}
