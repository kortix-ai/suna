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
import { ProgressRing } from '../../primitives/progress-ring';
import { UserAvatar } from '../../primitives/user-avatar';
import { StatusBadge, StatusDot, type StatusTone } from '../../primitives/status';
import { uiRoutes } from '../../lib/routes';
import { useUiViewerId } from '../../providers/ui-provider';
import { useAccountMembers } from '../account-hub/use-account-members';
import { useNewProjectSession } from '../hooks/projects/use-new-project-session';
import { MAKE_GOAL_PROMPT } from '@kortix/sdk';
import { useProjectAccountId } from '@kortix/sdk/react';
import { useCallback, useMemo } from 'react';

/**
 * One accent per meaning: orange only where a person must act, green only for
 * done, every other state neutral (black and white carry the page).
 */
const STATUS_TONE: Record<ProjectGoalStatus, StatusTone> = {
  draft: 'neutral',
  active: 'neutral',
  waiting_on_user: 'warning',
  waiting_external: 'neutral',
  verifying: 'neutral',
  done: 'success',
  stopped: 'neutral',
  abandoned: 'neutral',
};

/** The state chip. A paused open goal reads "Paused", whatever its state. */
export function GoalStatusBadge({ status, paused }: { status: ProjectGoalStatus | null | undefined; paused?: boolean }) {
  const t = useTranslations('goals');
  if (!status) return null;
  const tone = paused && !CLOSED.has(status) ? 'neutral' : (STATUS_TONE[status] ?? 'neutral');
  // The neutral status fill is the page white: a muted fill keeps the chip visible.
  return (
    <StatusBadge tone={tone} className={tone === 'neutral' ? 'bg-muted' : undefined}>
      {paused && !CLOSED.has(status) ? t('paused') : t(`status.${status}`)}
    </StatusBadge>
  );
}

const CLOSED = new Set<ProjectGoalStatus>(['done', 'stopped', 'abandoned']);

/** A person paused the goal (GOAL.md `paused_at`) and it is still open. */
export function goalPaused(goal: Pick<ProjectGoal, 'goal' | 'health'>): boolean {
  return goal.health.state !== 'closed' && !!goal.goal?.paused_at;
}

/**
 * One sentence for where a goal stands and what happens next, the same on the
 * Goals list and the goal's page: closed, paused, the question it waits on a
 * person for, a problem, verifying, setting up, or working with its next check.
 */
export function useGoalStateText() {
  const t = useTranslations('goals');
  const issueText = useGoalIssueText();
  return (goal: ProjectGoal, locale: string, now: number): string => {
    const doc = goal.goal;
    if (!doc) return issueText('unreadable', goal);
    if (doc.status === 'done') return t('state.done');
    if (CLOSED.has(doc.status)) return t(`state.${doc.status === 'stopped' ? 'stopped' : 'abandoned'}`);
    if (doc.paused_at) return t('state.paused', { time: formatGoalTime(doc.paused_at, locale, now) });
    // Waiting on a person: the question itself is the sentence.
    const question = (doc.status === 'waiting_on_user' ? doc.waiting_on : null) ?? goalOpenAsks(doc)[0]?.title;
    if (question) return question;
    if (doc.status === 'waiting_on_user') return t('state.waitingOn');
    if (goal.health.issues[0]) return issueText(goal.health.issues[0], goal);
    if (doc.status === 'verifying') return t('state.verifying');
    if (doc.status === 'draft') return t('state.draft');
    const next = goal.heartbeat?.next_fire_at;
    return next ? t('state.working', { time: formatGoalTime(next, locale, now) }) : t('state.workingNoWake');
  };
}

/** Orange: a person must act (a question or a problem). Grey otherwise: green is kept for done (the ring). */
export function GoalHealthDot({ goal }: { goal: Pick<ProjectGoal, 'health'> & Partial<Pick<ProjectGoal, 'goal'>> }) {
  const open = goal.health.state !== 'closed';
  const paused = open && !!goal.goal?.paused_at;
  const waiting = open && !paused && (goal.goal?.status === 'waiting_on_user' || goalOpenAsks(goal.goal ?? null).length > 0);
  const tone: StatusTone =
    open && !paused && (waiting || goal.health.state === 'attention') ? 'warning' : 'neutral';
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

/** Done criteria met, as a ring and "met/total". Nothing while the goal has no criteria. */
export function GoalCriteriaProgress({ goal }: { goal: ProjectGoalDocument | null }) {
  const t = useTranslations('goals');
  const { met, total } = goalProgress(goal);
  if (total === 0) return null;
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs tabular-nums" aria-label={t('criteriaMet', { met, total })}>
      <ProgressRing value={(met / total) * 100} className="size-3.5" progressClassName={met === total ? 'text-kortix-green' : 'text-muted-foreground'} />
      <span aria-hidden>
        {met}/{total}
      </span>
    </span>
  );
}

export function goalProgress(goal: ProjectGoalDocument | null): { met: number; total: number } {
  const criteria = goal?.success_criteria ?? [];
  return { met: criteria.filter((c) => c.met).length, total: criteria.length };
}

/** Open asks for a person (not the agent): what the goal waits on someone for. */
export function goalOpenAsks(goal: ProjectGoalDocument | null): ProjectGoalItem[] {
  return (goal?.items ?? []).filter((i) => i.kind === 'ask' && i.status === 'open' && i.owner !== 'agent');
}

/** The goal waits on a person: its state is `waiting_on_user`, or it has an open ask. */
export function goalNeedsYou(goal: ProjectGoal): boolean {
  if (goal.health.state === 'closed' || goalPaused(goal)) return false;
  return goal.goal?.status === 'waiting_on_user' || goalOpenAsks(goal.goal).length > 0;
}

/** The goal runs into a problem no person was asked about: a health issue (no heartbeat, a failed wake, …). */
export function goalNeedsAttention(goal: ProjectGoal): boolean {
  return goal.health.state === 'attention' && !goalNeedsYou(goal) && !goalPaused(goal);
}

/** When the goal last woke: the heartbeat's last run, else the wake GOAL.md records. */
export function goalLastWake(goal: Pick<ProjectGoal, 'goal' | 'heartbeat'>): string | null {
  return goal.heartbeat?.last_fired_at ?? goal.goal?.last_wake_at ?? null;
}

/** Who a goal is for, by name: "You", the member's email, else "A teammate". */
export function useGoalPerson(projectId: string) {
  const t = useTranslations('goals');
  const viewerId = useUiViewerId();
  const members = useAccountMembers(useProjectAccountId(projectId) ?? undefined);
  const emails = useMemo(() => new Map((members.data ?? []).map((m) => [m.user_id, m.email])), [members.data]);
  return useCallback(
    (userId: string | null | undefined): string | null =>
      !userId ? null : userId === viewerId ? t('you') : (emails.get(userId) ?? t('anotherMember')),
    [emails, viewerId, t],
  );
}

/** The person a goal is for, as an avatar and a name ("You", their email, else "A teammate"). */
export function GoalPersonChip({ projectId, userId }: { projectId: string; userId: string | null | undefined }) {
  const t = useTranslations('goals');
  const viewerId = useUiViewerId();
  const members = useAccountMembers(useProjectAccountId(projectId) ?? undefined);
  if (!userId) return <span className="text-muted-foreground">{t('none')}</span>;
  const email = (members.data ?? []).find((m) => m.user_id === userId)?.email ?? '';
  const label = userId === viewerId ? t('you') : email || t('anotherMember');
  return (
    <span className="flex min-w-0 items-center gap-2">
      <UserAvatar email={email || userId} size="xs" />
      <span className="text-foreground truncate">{label}</span>
    </span>
  );
}

/**
 * Start a goal from its outcome: a new session whose first message is the
 * outcome plus `MAKE_GOAL_PROMPT`, so the agent writes GOAL.md and its done
 * criteria.
 */
export function useStartGoal(projectId: string) {
  const newSession = useNewProjectSession(projectId);
  return useCallback(
    (outcome: string) =>
      newSession({
        create: { pending_prompt: { text: `${outcome.trim()}\n\n${MAKE_GOAL_PROMPT}`, agent: null, model: null, variant: null } },
      }),
    [newSession],
  );
}

/** The goal is for this person (GOAL.md `assigned_user`). */
export function goalAssignedTo(goal: Pick<ProjectGoal, 'goal'>, userId: string | null | undefined): boolean {
  return !!userId && goal.goal?.assigned_user === userId;
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
