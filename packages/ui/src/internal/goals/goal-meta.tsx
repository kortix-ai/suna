'use client';

/**
 * The shared vocabulary of the Goals surfaces (flag `goals`): the status chip,
 * the health line, progress and "needs you". The Goals page, the sidebar row
 * and the session header chip all read a goal through these, so a status or a
 * health issue reads the same everywhere.
 */

import type { ProjectGoal, ProjectGoalDocument, ProjectGoalIssue, ProjectGoalItem, ProjectGoalStatus } from '@kortix/sdk';
import { formatFireTime } from '../reminders/reminder-format';
import { useTranslations } from '../../i18n';
import { StatusBadge, StatusDot, type StatusTone } from '../../primitives/status';
import { uiRoutes } from '../../lib/routes';

const STATUS_TONE: Record<ProjectGoalStatus, StatusTone> = {
  draft: 'neutral',
  active: 'info',
  waiting_on_user: 'warning',
  waiting_external: 'neutral',
  verifying: 'info',
  done: 'success',
  abandoned: 'neutral',
};

export function GoalStatusBadge({ status }: { status: ProjectGoalStatus | null | undefined }) {
  const t = useTranslations('goals');
  if (!status) return null;
  return <StatusBadge tone={STATUS_TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</StatusBadge>;
}

/** Green: running. Orange: needs attention. Grey: closed. */
export function GoalHealthDot({ goal }: { goal: Pick<ProjectGoal, 'health'> }) {
  const tone: StatusTone = goal.health.state === 'healthy' ? 'success' : goal.health.state === 'attention' ? 'warning' : 'neutral';
  return <StatusDot tone={tone} />;
}

/** One sentence per issue, for the health line and its tooltip. */
export function useGoalIssueText() {
  const t = useTranslations('goals');
  return (issue: ProjectGoalIssue, goal: Pick<ProjectGoal, 'heartbeat'>) =>
    issue === 'heartbeat_failed'
      ? t('issue.heartbeat_failed', { error: goal.heartbeat?.last_error ?? '—' })
      : t(`issue.${issue}`);
}

export function goalProgress(goal: ProjectGoalDocument | null): { met: number; total: number } {
  const criteria = goal?.success_criteria ?? [];
  return { met: criteria.filter((c) => c.met).length, total: criteria.length };
}

/** Open asks for a person (not the agent): what the goal waits on someone for. */
export function goalOpenAsks(goal: ProjectGoalDocument | null): ProjectGoalItem[] {
  return (goal?.items ?? []).filter((i) => i.kind === 'ask' && i.status === 'open' && i.owner !== 'agent');
}

/** The goal needs a person: an open ask, or a health issue. */
export function goalNeedsYou(goal: ProjectGoal): boolean {
  return goal.health.state === 'attention' || (goal.health.state !== 'closed' && goalOpenAsks(goal.goal).length > 0);
}

/** "in 33 min", "2 hr ago", "Tue 09:00": the reminders time format. */
export function formatGoalTime(iso: string | null | undefined, locale: string, now: number): string {
  return iso ? formatFireTime(iso, locale, now) : '—';
}

export function goalHref(projectId: string, goal: Pick<ProjectGoal, 'scope' | 'slug'>): string | null {
  const list = uiRoutes().goals(projectId);
  return list ? `${list}/${goal.scope}/${encodeURIComponent(goal.slug)}` : null;
}

/** The current time, re-read every 30 seconds: relative times and health stay current. */
export { useNow as useGoalClock } from '../reminders/use-refetch-after-fire';
