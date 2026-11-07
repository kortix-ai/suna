/**
 * Goals: tell the person a goal is for (its assigned user, else its creator)
 * when it needs them, is blocked, or is decided. One notification per goal,
 * kind and UTC day: the dedupe key carries all three.
 *
 * That person is told only while they may read the project (an account member
 * with `project.read`), the access the goal page requires. An assignee who
 * lost the project does not silence the goal: its creator is told instead.
 * When neither may read it, nothing is sent.
 *
 * The goal's event log also records the event, and the goal page shows it.
 * The inbox row links to the owner session (the inbox has no goal subject
 * yet); its title names the goal.
 */
import type { NotificationKindName } from '@kortix/shared/notification-kinds';
import { logger } from '../../lib/logger';
import { filterProjectRecipients } from '../../notifications/access';
import { deliver } from '../../notifications/notifier';
import { utcDay } from './rules';
import type { GoalRow } from './store';

export type GoalNoticeKind = 'needs_you' | 'blocked' | 'verified_done' | 'verification_failed' | 'verification_stalled';

const KIND: Record<GoalNoticeKind, NotificationKindName> = {
  needs_you: 'question',
  blocked: 'automation_failed',
  verified_done: 'turn_done',
  verification_failed: 'automation_failed',
  verification_stalled: 'automation_failed',
};

const LINE: Record<GoalNoticeKind, string> = {
  needs_you: 'needs you',
  blocked: 'is blocked',
  verified_done: 'is done: every criterion passed an independent check',
  verification_failed: 'did not pass verification',
  verification_stalled: 'has been in verification for over 24 h',
};

/** The web page of one goal. */
export function goalDeepLink(goal: Pick<GoalRow, 'projectId' | 'goalId'>): string {
  return `/workspaces/${goal.projectId}/goals/${goal.goalId}`;
}

export type GoalNoticeSubject = Pick<
  GoalRow,
  'goalId' | 'accountId' | 'projectId' | 'ownerSessionId' | 'title' | 'assignedUserId' | 'createdByUserId'
>;

export async function notifyGoal(goal: GoalNoticeSubject, kind: GoalNoticeKind, detail: string, now: Date): Promise<void> {
  const dedupeKey = `goal:${goal.goalId}:${kind}:${utcDay(now)}`;
  try {
    const candidates = [goal.assignedUserId, goal.createdByUserId].filter((id): id is string => Boolean(id));
    const [recipient] = await filterProjectRecipients(goal.accountId, goal.projectId, candidates);
    if (!recipient) return;
    await deliver({
      kind: KIND[kind],
      accountId: goal.accountId,
      projectId: goal.projectId,
      sessionId: goal.ownerSessionId,
      title: `Goal "${goal.title}" ${LINE[kind]}`,
      body: `${detail} ${goalDeepLink(goal)}`.trim(),
      dedupeKey,
      recipients: [recipient],
    });
  } catch (error) {
    logger.warn('[goals] notification failed', { goal_id: goal.goalId, kind, error: error instanceof Error ? error.message : String(error) });
  }
}
