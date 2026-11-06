/**
 * Wake a goal (project flag `goals`) on an event.
 *
 * The goal is the `project_goals` row of the session the event came from: the
 * session is the goal's owner or verifier (`projects/goals/store.ts`
 * `goalOfSession`). Never a folder string: two people's personal goals share
 * the sandbox alias `/drives/me/Goals/<slug>` (G08).
 *
 * "Wake" = the goal admission gate (flag, state, pause, the per-day wake cap,
 * billing: `projects/goals/admission.ts`), then one prompt into the goal's
 * owner session carrying the event's own reason text (G09), keyed
 * `goal-event:<goal_id>:<source>:<source_id>` so a repeated event queues once.
 *
 * SEAM (Triggers): `wakeGoal` is the one entry point for every event that
 * targets a goal. Today one source calls it: a merged change request whose
 * origin session works on a goal (`wakeGoalForMergedChangeRequest`, from the
 * CR merge route).
 */
import { logger } from '../../lib/logger';
import { admitGoalWake } from '../goals/admission';
import { goalEffects } from '../goals/effects';
import { goalWakePrompt } from '../goals/rules';
import { goalOfSession, type GoalRow } from '../goals/store';
import type { ProjectRow } from './serializers';

export type GoalWakeResult = 'woken' | 'refused' | 'failed';

export async function wakeGoal(input: {
  project: ProjectRow;
  goal: GoalRow;
  source: string;
  sourceId: string;
  reason: string;
}): Promise<{ result: GoalWakeResult; refusal?: string }> {
  const { project, goal } = input;
  const key = `goal-event:${goal.goalId}:${input.source}:${input.sourceId}`;
  const verdict = await admitGoalWake({ project, goal, idempotencyKey: key, source: input.source });
  if (!verdict.admitted) return { result: 'refused', refusal: verdict.reason };
  const owner = verdict.goal.ownerSessionId;
  if (!owner) return { result: 'failed' };
  const queued = await goalEffects().queuePrompt({
    project,
    sessionId: owner,
    userId: verdict.goal.createdByUserId,
    text: `${goalWakePrompt(verdict.goal.boxFolder, verdict.goal.goalId)} ${input.reason}`,
    key,
  });
  return { result: queued ? 'woken' : 'failed' };
}

/** A merged change request wakes the goal its origin session works on. */
export async function wakeGoalForMergedChangeRequest(input: {
  project: ProjectRow;
  changeRequest: { number: number; title: string; originSessionId: string | null };
}): Promise<GoalWakeResult | 'no_goal'> {
  const sessionId = input.changeRequest.originSessionId;
  if (!sessionId) return 'no_goal';
  const goal = await goalOfSession(sessionId);
  if (!goal || goal.projectId !== input.project.projectId) return 'no_goal';
  const { result, refusal } = await wakeGoal({
    project: input.project,
    goal,
    source: 'change_request',
    sourceId: String(input.changeRequest.number),
    reason: `Change request #${input.changeRequest.number} "${input.changeRequest.title}" merged.`,
  });
  if (result !== 'woken') logger.info('[goal-wake] change request merge did not wake the goal', { goal_id: goal.goalId, result, refusal });
  return result;
}
