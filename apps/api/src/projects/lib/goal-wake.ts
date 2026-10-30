/**
 * Wake a goal (project flag `goals`) on an event.
 *
 * A goal has no server object: it is a folder in Files (`Goals/<slug>/GOAL.md`,
 * written by `kortix goals` in its owner session) plus a heartbeat loop on that
 * owner session whose prompt names the folder (`Goal wake: <folder>. …`). So
 * "wake the goal" = fire its heartbeat loop now with the reason appended. The
 * loop path already resolves the current owner, starts a successor when the
 * owner's session failed, and applies the run caps.
 *
 * SEAM (Triggers): `wakeGoal` is the one entry point for every event that
 * targets a goal. Today one source calls it: a merged change request whose
 * origin session carries the session metadata `goal: <folder>`
 * (`wakeGoalForMergedChangeRequest`, from the CR merge route). When
 * Triggers land as source + target, the "change request merged" source and
 * any trigger with a goal target call `wakeGoal` here instead.
 */
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import type { GitTriggerSpec } from '../triggers';
import type { ProjectRow } from './serializers';
import { listProjectReminders, reminderPromptText } from './session-reminders';
import { fireGitTrigger } from './trigger-fire';

type ReminderRow = Awaited<ReturnType<typeof listProjectReminders>>[number];

/** The goal's live heartbeat: an enabled loop whose prompt names exactly this goal folder. */
export function findGoalHeartbeat<T extends Pick<ReminderRow, 'enabled' | 'nextFireAt' | 'scheduleSpec'>>(
  rows: readonly T[],
  goalFolder: string,
): T | null {
  const marker = `Goal wake: ${goalFolder}.`;
  return (
    rows.find((row) => {
      const prompt = (row.scheduleSpec as unknown as GitTriggerSpec | null)?.promptTemplate ?? '';
      return row.enabled && row.nextFireAt !== null && prompt.includes(marker);
    }) ?? null
  );
}

export type GoalWakeResult = 'woken' | 'no_heartbeat' | 'flag_off' | 'failed';

export async function wakeGoal(input: { project: ProjectRow; goalFolder: string; reason: string }): Promise<GoalWakeResult> {
  if (!resolveFeatureFlag(input.project.metadata, 'goals')) return 'flag_off';
  const heartbeat = findGoalHeartbeat(await listProjectReminders(input.project.projectId), input.goalFolder);
  if (!heartbeat) return 'no_heartbeat';
  const spec = heartbeat.scheduleSpec as unknown as GitTriggerSpec;
  const result = await fireGitTrigger({
    spec,
    project: input.project,
    payload: {},
    renderedPrompt: reminderPromptText({ ...spec, promptTemplate: `${spec.promptTemplate} ${input.reason}` }),
    source: 'event',
  });
  return result.status === 'fired' || result.status === 'queued' ? 'woken' : 'failed';
}

/** A merged change request wakes the goal its origin session works on (session metadata `goal`). */
export async function wakeGoalForMergedChangeRequest(input: {
  project: ProjectRow;
  changeRequest: { number: number; title: string; originSessionId: string | null };
}): Promise<GoalWakeResult | 'no_goal'> {
  const sessionId = input.changeRequest.originSessionId;
  if (!sessionId) return 'no_goal';
  const [session] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const goalFolder = (session?.metadata as Record<string, unknown> | null)?.goal;
  if (typeof goalFolder !== 'string' || !goalFolder) return 'no_goal';
  const result = await wakeGoal({
    project: input.project,
    goalFolder,
    reason: `Change request #${input.changeRequest.number} "${input.changeRequest.title}" merged.`,
  });
  if (result === 'failed') logger.warn('[goal-wake] change request merge did not wake the goal', { sessionId, goalFolder });
  return result;
}
