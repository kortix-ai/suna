/**
 * Goals: the reconciler (worker job `goal-reconciler`, leader only). Each tick
 * looks at up to `GOAL_RECONCILE_BATCH` goals and brings what lives outside
 * the row back in line with it:
 *
 * - a create left `setup` (older than 30 s): finish its steps;
 * - an open goal: its heartbeat exists and is on exactly when it should be
 *   (event `repaired` when it was not); a closed goal: no heartbeat;
 * - `wake_cap` of a past UTC day: cleared;
 * - the owner session failed or is gone and no successor took over:
 *   `owner_lost`, the assigned person told once;
 * - verifying for more than 24 h: `verification_stalled` once.
 *
 * The cursor (`afterGoalId`) is the leader's memory: a new leader starts the
 * pass over, which repeats harmless checks. One pass of the whole table is
 * `count / batch` ticks.
 */
import { GOAL_LIMITS } from '@kortix/api-contract';
import { eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import type { ProjectRow } from '../lib/serializers';
import { goalEffects, readHeartbeat, sessionHealth } from './effects';
import { notifyGoal } from './notify';
import { isOpenState, utcDay } from './rules';
import { applyHeartbeat, dropHeartbeat, finishGoalSetup, heartbeatWanted, moveHeartbeat } from './service';
import { appendGoalEvent, dbNow, forgetGoalPrompts, goalsToReconcile, pendingGoalPrompts, writeGoal, type GoalRow } from './store';
import { projectsView } from '../../workspaces/rows';

export const GOAL_RECONCILE_BATCH = 50;
const SETUP_GRACE_MS = 30_000;

export interface GoalReconcileResult {
  checked: number;
  setup: number;
  repaired: number;
  unblocked: number;
  ownerLost: number;
  stalled: number;
  /** The last goal of this tick; null when the pass reached the end. */
  cursor: string | null;
}

async function loadProject(projectId: string): Promise<ProjectRow | null> {
  const [row] = await db.select().from(projectsView).where(eq(projectsView.projectId, projectId)).limit(1);
  return row ?? null;
}

/** Does the heartbeat match what the row wants? */
async function heartbeatDrift(goal: GoalRow): Promise<string | null> {
  if (!isOpenState(goal.state)) return goal.heartbeatReminderId ? 'closed goal holds a heartbeat' : null;
  if (goal.blockedReason === 'setup') return null;
  if (!goal.heartbeatReminderId) return 'open goal has no heartbeat';
  const hb = await readHeartbeat(goal.projectId, goal.heartbeatReminderId);
  if (!hb) return 'heartbeat is gone';
  if (hb.sessionId !== goal.ownerSessionId) return "heartbeat is pinned to a session that is not the goal's owner";
  const chase = goal.state === 'waiting_on_user' && goal.chaseAt !== null && !goal.pausedAt;
  const wanted = heartbeatWanted(goal) || chase;
  // A capped goal's heartbeat waits for the next UTC day: on, with a next fire.
  if (wanted && !(hb.enabled && hb.nextFireAt)) return 'heartbeat is off while the goal runs';
  if (!wanted && hb.enabled && hb.nextFireAt) return 'heartbeat is on while the goal should not wake';
  return null;
}

export async function reconcileGoal(goal: GoalRow, now: Date, result: GoalReconcileResult): Promise<void> {
  result.checked += 1;
  if (goal.blockedReason === 'setup') {
    if (now.getTime() - goal.createdAt.getTime() < SETUP_GRACE_MS) return;
    const project = await loadProject(goal.projectId);
    if (!project) return;
    const after = await finishGoalSetup(project, goal);
    if (after.blockedReason !== 'setup') result.setup += 1;
    return;
  }
  if (!isOpenState(goal.state)) {
    const moot = pendingGoalPrompts(goal).map((p) => p.key);
    if (moot.length) await forgetGoalPrompts(goal.goalId, moot);
    if (goal.heartbeatReminderId) {
      await dropHeartbeat(goal);
      await appendGoalEvent(goal, { kind: 'repaired', actorKind: 'platform', actorId: null, message: 'Removed the heartbeat of a closed goal.' });
      result.repaired += 1;
    }
    return;
  }
  if (goal.blockedReason === 'wake_cap' && goal.wakeDay !== null && goal.wakeDay < utcDay(now)) {
    const cleared = await writeGoal(goal.projectId, goal.goalId, (row) =>
      row.blockedReason === 'wake_cap'
        ? { patch: { blockedReason: null }, keepRevision: true, event: { kind: 'unblocked', actorKind: 'platform', actorId: null, message: 'A new UTC day: the wake cap is reset.' } }
        : { unchanged: true },
    );
    goal = cleared.row;
    result.unblocked += 1;
  }
  if (goal.ownerSessionId && goal.blockedReason !== 'owner_lost' && !goal.pausedAt) {
    const health = await sessionHealth(goal.ownerSessionId);
    // A failed owner keeps its heartbeat: the next fire starts a successor. A
    // deleted one has nothing to hand over from. A failed owner of a goal whose
    // heartbeat is off (a draft, a goal waiting on a person) never gets a
    // successor either: nothing fires. Both block until a person restarts it.
    if (health === 'missing' || (health === 'failed' && isOpenState(goal.state) && !heartbeatWanted(goal))) {
      const lost = await writeGoal(goal.projectId, goal.goalId, (row) =>
        row.blockedReason === 'owner_lost'
          ? { unchanged: true }
          : { patch: { blockedReason: 'owner_lost' }, keepRevision: true, event: { kind: 'blocked', actorKind: 'platform', actorId: null, message: health === 'missing' ? 'The owner session is gone and no successor took over.' : 'The owner session failed and nothing wakes a successor.', data: { reason: 'owner_lost' } } },
      );
      // Nothing may fire into the lost owner: the heartbeat goes off until a restart.
      await applyHeartbeat(lost.row);
      await notifyGoal(lost.row, 'blocked', 'Its owner session stopped working. Restart the goal to give it a new owner.', now);
      result.ownerLost += 1;
      return;
    }
  }
  // Prompts that did not queue (an answer, a resume, a verifier's first prompt): queue them
  // again under their keys. Held while paused (delivery would refuse them); dropped on a closed goal.
  const pending = pendingGoalPrompts(goal);
  if (pending.length && !goal.pausedAt) {
    const project = await loadProject(goal.projectId);
    if (project) {
      const sent: string[] = [];
      for (const p of pending) {
        // Re-aim at the goal as it is now: a verifier prompt only for the current attempt's
        // verifier; any other prompt (answer, resume, handover, verdict wake) to the current
        // owner, which a handover or a successor may have replaced.
        const attempt = /^goal-verify:[^:]+:(\d+)$/.exec(p.key)?.[1];
        const to = attempt !== undefined
          ? goal.state === 'verifying' && Number(attempt) === goal.verification?.attempt ? goal.verifierSessionId : null
          : goal.ownerSessionId;
        if (!to) sent.push(p.key);
        else if (await goalEffects().queuePrompt({ project, ...p, sessionId: to })) sent.push(p.key);
      }
      await forgetGoalPrompts(goal.goalId, sent);
      result.repaired += sent.length;
    }
  }
  if (goal.state === 'verifying' && goal.verification?.started_at) {
    const age = now.getTime() - Date.parse(goal.verification.started_at);
    if (age > GOAL_LIMITS.verification_stalled_hours * 3600_000) {
      const fresh = await appendGoalEvent(goal, {
        kind: 'verification_stalled',
        actorKind: 'platform',
        actorId: null,
        message: `Verification attempt ${goal.verification.attempt} has run for over ${GOAL_LIMITS.verification_stalled_hours} h.`,
        dedupeKey: `stalled:${goal.verification.attempt}`,
      });
      if (fresh) {
        await notifyGoal(goal, 'verification_stalled', 'Its verification has not finished in 24 h.', now);
        result.stalled += 1;
      }
    }
  }
  const drift = await heartbeatDrift(goal);
  if (drift) {
    if (drift.startsWith('heartbeat is pinned') && goal.ownerSessionId) await moveHeartbeat(goal, goal.ownerSessionId, heartbeatWanted(goal));
    else await applyHeartbeat(goal);
    await appendGoalEvent(goal, { kind: 'repaired', actorKind: 'platform', actorId: null, message: `Heartbeat repaired: ${drift}.` });
    result.repaired += 1;
  }
}

/** One tick. `afterGoalId` continues the pass where the last tick stopped. */
export async function runGoalReconcilerTick(afterGoalId: string | null, now?: Date): Promise<GoalReconcileResult> {
  const at = now ?? (await dbNow());
  const rows = await goalsToReconcile(GOAL_RECONCILE_BATCH, afterGoalId);
  const result: GoalReconcileResult = { checked: 0, setup: 0, repaired: 0, unblocked: 0, ownerLost: 0, stalled: 0, cursor: null };
  for (const goal of rows) {
    try {
      await reconcileGoal(goal, at, result);
    } catch (error) {
      logger.warn('[goals] reconcile failed for one goal', { goal_id: goal.goalId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  result.cursor = rows.length === GOAL_RECONCILE_BATCH ? rows[rows.length - 1]!.goalId : null;
  return result;
}
