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

/** A goal the caller holds: the server record when there is one, else (an older caller) GOAL.md and its heartbeat. */
type GoalLike = Pick<ProjectGoal, 'health'> & Partial<Pick<ProjectGoal, 'goal' | 'heartbeat' | 'record' | 'blockedReason'>>;

/**
 * A person paused the goal: the server record's `paused_at`. Only a person
 * can pause, and the API enforces it, so the record is the truth. Without a
 * record (an older caller): GOAL.md `paused_at` AND a heartbeat that is not running.
 */
export function goalPaused(goal: GoalLike): boolean {
  if (goal.health.state === 'closed') return false;
  if (goal.record) return !!goal.record.paused_at;
  return !!goal.goal?.paused_at && goal.heartbeat?.state !== 'active';
}

/** When the goal wakes next: the server's `next_wake_at`, else the heartbeat's next fire. Null while paused or waiting. */
export function goalNextWake(goal: GoalLike): string | null {
  if (goal.record) return goal.record.next_wake_at;
  return goal.heartbeat?.state === 'active' ? (goal.heartbeat.next_fire_at ?? null) : null;
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
    if (goalPaused(goal) && doc.paused_at) return t('state.paused', { time: formatGoalTime(doc.paused_at, locale, now) });
    // Blocked: the reason is the sentence; the goal page adds the next step.
    if (goal.blockedReason) return issueText('blocked', goal);
    // Waiting on a person: the question itself is the sentence. GOAL.md is hand-editable: only text counts.
    const asked = doc.status === 'waiting_on_user' && typeof doc.waiting_on === 'string' ? doc.waiting_on : null;
    const ask = goalOpenAsks(doc)[0]?.title;
    const question = asked || (typeof ask === 'string' ? ask : null);
    if (question) return question;
    if (doc.status === 'waiting_on_user') return t('state.waitingOn');
    if (goal.health.issues[0]) return issueText(goal.health.issues[0], goal);
    if (doc.status === 'verifying') return t('state.verifying');
    if (doc.status === 'draft') return t('state.draft');
    const next = goalNextWake(goal);
    return next ? t('state.working', { time: formatGoalTime(next, locale, now) }) : t('state.workingNoWake');
  };
}

/** Orange: a person must act (a question or a problem). Grey otherwise: green is kept for done (the ring). */
export function GoalHealthDot({ goal }: { goal: GoalLike }) {
  const open = goal.health.state !== 'closed';
  const paused = goalPaused(goal);
  const waiting = open && !paused && (goal.goal?.status === 'waiting_on_user' || goalOpenAsks(goal.goal ?? null).length > 0);
  const tone: StatusTone =
    open && !paused && (waiting || goal.health.state === 'attention') ? 'warning' : 'neutral';
  return <StatusDot tone={tone} />;
}

/** What a goal's icon draws: its state, or a problem a person must look at. */
export type GoalIconState =
  | 'draft'
  | 'active'
  | 'verifying'
  | 'waiting'
  | 'attention'
  | 'paused'
  | 'done'
  | 'stopped';

/** The icon state of a goal in a list: paused and attention win over the state in GOAL.md. */
export function goalIconState(goal: GoalLike): GoalIconState {
  const doc = goal.goal;
  if (!doc) return 'attention';
  if (doc.status === 'done') return 'done';
  if (CLOSED.has(doc.status)) return 'stopped';
  if (goalPaused(goal)) return 'paused';
  if (doc.status === 'waiting_on_user' || goalOpenAsks(doc).length > 0) return 'waiting';
  if (goal.health.state === 'attention') return 'attention';
  if (doc.status === 'verifying') return 'verifying';
  if (doc.status === 'draft') return 'draft';
  return 'active';
}

/** The icon state of a state move in the activity feed. */
export function goalStatusIconState(status: ProjectGoalStatus): GoalIconState {
  if (status === 'done') return 'done';
  if (CLOSED.has(status)) return 'stopped';
  if (status === 'waiting_on_user') return 'waiting';
  if (status === 'verifying') return 'verifying';
  if (status === 'draft') return 'draft';
  return 'active';
}

const R = 6.25;
/** A pie wedge from 12 o'clock, clockwise, `fraction` of the inner disc (radius 3.5). */
function wedge(fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  if (f >= 1) return 'M8 4.5 A3.5 3.5 0 1 1 7.999 4.5 Z';
  const a = f * 2 * Math.PI;
  const x = 8 + 3.5 * Math.sin(a);
  const y = 8 - 3.5 * Math.cos(a);
  return `M8 8 L8 4.5 A3.5 3.5 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
}

/**
 * A goal's status icon: the ring is the outcome, what sits inside it says where the goal
 * stands. Draft: a dashed ring (nothing committed yet). In progress: a pie that fills as
 * done criteria are met. Verifying: a full pie (every criterion claimed, the check is on
 * it). Waiting on you: an orange core. Attention: an orange "!". Paused: two bars.
 * Done: a green disc with a check. Stopped: a slash. Color only where a person acts
 * (orange) or the outcome is reached (green); still glyphs, nothing animates.
 */
export function GoalStatusIcon({
  state,
  progress = 0,
  label,
  tone,
  className,
}: {
  state: GoalIconState;
  /** A color for the glyph instead of the state's own (a CSS color or `var(--…)`). */
  tone?: string;
  /** Done criteria met, 0..1: the pie of an in-progress goal. */
  progress?: number;
  /** The accessible name. Omitted: the icon is decoration beside a label. */
  label?: string;
  className?: string;
}) {
  const color =
    tone ??
    (state === 'done' ? 'var(--kortix-green)' : state === 'waiting' || state === 'attention' ? 'var(--kortix-orange)' : 'var(--muted-foreground)');
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color }}
      className={className ? `shrink-0 ${className}` : 'shrink-0'}
      data-goal-icon={state}
      {...a11y}
    >
      {state === 'done' ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
          <path d="M5.2 8.2 L7.1 10 L10.8 6.2" stroke="var(--background)" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r={R} strokeDasharray={state === 'draft' ? '2.4 2.5' : undefined} />
          {state === 'active' && progress > 0 ? <path d={wedge(progress)} fill="currentColor" stroke="none" /> : null}
          {state === 'verifying' ? <path d={wedge(1)} fill="currentColor" stroke="none" opacity="0.55" /> : null}
          {state === 'waiting' ? <circle cx="8" cy="8" r="2.75" fill="currentColor" stroke="none" /> : null}
          {state === 'attention' ? (
            <>
              <path d="M8 5 L8 8.6" />
              <circle cx="8" cy="11" r="0.4" fill="currentColor" />
            </>
          ) : null}
          {state === 'paused' ? <path d="M6.6 5.6 L6.6 10.4 M9.4 5.6 L9.4 10.4" /> : null}
          {state === 'stopped' ? <path d="M5.4 10.6 L10.6 5.4" /> : null}
        </>
      )}
    </svg>
  );
}

/** One sentence per issue, for the health line and its tooltip. `blocked` says why, from the server's `blocked_reason`. */
export function useGoalIssueText() {
  const t = useTranslations('goals');
  return (issue: ProjectGoalIssue, goal: Partial<Pick<ProjectGoal, 'heartbeat' | 'blockedReason' | 'record'>>) =>
    issue === 'heartbeat_failed'
      ? t('issue.heartbeat_failed', { error: goal.heartbeat?.last_error ?? '—' })
      : issue === 'blocked'
        ? goal.blockedReason
          ? t(`blocked.${goal.blockedReason}`, { max: goal.blockedReason === 'session_cap' ? (goal.record?.max_sessions ?? 0) : (goal.record?.max_wakes_per_day ?? 0) })
          : t('issue.blocked')
        : t(`issue.${issue}`);
}

/** The next step a person takes for a blocked goal, one sentence. */
export function useGoalBlockedNextStep() {
  const t = useTranslations('goals');
  return (goal: Pick<ProjectGoal, 'blockedReason'>): string | null => (goal.blockedReason ? t(`blockedNext.${goal.blockedReason}`) : null);
}

/**
 * Done criteria the agent reports met, as a ring and "met/total". The ring
 * turns green only when the verifier passed every criterion. Nothing while
 * the goal has no criteria.
 */
export function GoalCriteriaProgress({ goal, ring = true }: { goal: ProjectGoal | ProjectGoalDocument | null; ring?: boolean }) {
  const t = useTranslations('goals');
  const progress = goal && 'record' in goal ? goalCriteriaStatus(goal) : { ...goalProgress(goal), verified: 0 };
  const { met, total, verified } = progress;
  if (total === 0) return null;
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs tabular-nums" aria-label={t('criteriaMet', { met, total })}>
      {ring ? <ProgressRing value={(met / total) * 100} className="size-3.5" progressClassName={verified === total ? 'text-kortix-green' : 'text-muted-foreground'} /> : null}
      <span aria-hidden>
        {met}/{total}
      </span>
    </span>
  );
}

/** Criteria the agent reports met (its claim, not verification) and the total. */
export function goalProgress(goal: ProjectGoalDocument | null): { met: number; total: number } {
  const criteria = goal?.success_criteria ?? [];
  return { met: criteria.filter((c) => c.met).length, total: criteria.length };
}

/** Criteria reported met by the agent, verified by the independent verifier, and the total. */
export function goalCriteriaStatus(goal: Pick<ProjectGoal, 'criteria'>): { met: number; verified: number; total: number } {
  return {
    met: goal.criteria.filter((c) => c.reported_met).length,
    verified: goal.criteria.filter((c) => c.verified).length,
    total: goal.criteria.length,
  };
}

/** Open asks for a person (not the agent): what the goal waits on someone for. */
export function goalOpenAsks(goal: ProjectGoalDocument | null): ProjectGoalItem[] {
  return (goal?.items ?? []).filter((i) => i.kind === 'ask' && i.status === 'open' && i.owner !== 'agent');
}

/** The goal waits on a person: its state is `waiting_on_user`, or it has an open ask. */
export function goalNeedsYou(goal: GoalLike): boolean {
  if (goal.health.state === 'closed' || goalPaused(goal)) return false;
  return goal.goal?.status === 'waiting_on_user' || goalOpenAsks(goal.goal ?? null).length > 0;
}

/** The goal runs into a problem no person was asked about: a health issue (no heartbeat, a failed wake, …). */
export function goalNeedsAttention(goal: GoalLike): boolean {
  return goal.health.state === 'attention' && !goalNeedsYou(goal) && !goalPaused(goal);
}

/** When the goal last woke: the server's `last_wake_at`, else the heartbeat's last run, else the wake GOAL.md records. */
export function goalLastWake(goal: Partial<Pick<ProjectGoal, 'goal' | 'heartbeat' | 'record'>>): string | null {
  if (goal.record) return goal.record.last_wake_at;
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
  if (!userId) return <span className="text-muted-foreground">—</span>;
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

/** A goal's page: `/goals/<goal_id>`. Without an id (an older caller): the legacy `/goals/<scope>/<slug>` link, which resolves when the slug is unique. */
export function goalHref(projectId: string, goal: Pick<ProjectGoal, 'scope' | 'slug'> & Partial<Pick<ProjectGoal, 'goalId'>>): string | null {
  const list = uiRoutes().goals(projectId);
  if (!list) return null;
  return goal.goalId ? `${list}/${encodeURIComponent(goal.goalId)}` : `${list}/${goal.scope}/${encodeURIComponent(goal.slug)}`;
}

/** The current time, re-read every 30 seconds: relative times and health stay current. */
export { useNow as useGoalClock } from '../reminders/use-refetch-after-fire';
