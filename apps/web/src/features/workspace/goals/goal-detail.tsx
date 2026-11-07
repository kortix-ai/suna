'use client';

import { Button } from '@kortix/ui/button';
import { ButtonGroup } from '@kortix/ui/button-group';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@kortix/ui/disclosure';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@kortix/ui/dropdown-menu';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { Hint } from '@kortix/ui/hint';
import { InfoBanner } from '@kortix/ui/info-banner';
import { InputGroup, InputGroupAddon, InputGroupButton } from '@kortix/ui/input-group';
import { AgentMark } from '@kortix/ui/internal/components/agent-mark';
import Loading from '@kortix/ui/loading';
import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { Skeleton } from '@kortix/ui/skeleton';
import { infoToast, successToast } from '@kortix/ui/toast';
import { uiRoutes } from '@kortix/ui';
import {
  formatGoalTime,
  goalCriteriaStatus,
  goalHref,
  goalIconState,
  goalLastWake,
  goalNextWake,
  goalPaused,
  GoalPersonChip,
  GoalStatusIcon,
  goalStatusIconState,
  ProjectPageHeader,
  useGoalBlockedNextStep,
  useGoalClock,
  useGoalIssueText,
  useGoalPerson,
} from '@kortix/ui/workspace';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  ApiError,
  generateSessionId,
  ProjectGoalConflictError,
  type ProjectGoal,
  type ProjectGoalEvent,
  type ProjectGoalStatus,
} from '@kortix/sdk';
import {
  useProjectGoal,
  useProjectGoalControl,
  useProjectGoalEvents,
  useProjectGoalFiles,
  useProjectGoals,
  useProjectSession,
  type ProjectGoalControlInput,
} from '@kortix/sdk/react';
import {
  ArrowUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  ChatCircleIcon,
  ChatTextIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CircleIcon,
  ClockCounterClockwiseIcon,
  ClockIcon,
  DotsThreeIcon,
  FolderOpenIcon,
  HourglassIcon,
  LightningIcon,
  LockSimpleIcon,
  PauseIcon,
  PlayIcon,
  ShareNetworkIcon,
  StopIcon,
  UsersIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { parseGoalLog } from './goal-log';
import { GoalShareModal } from './goal-share-modal';
import { useAuth } from '@/features/providers/auth-provider';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * /workspaces/[id]/goals/[goalId] — one goal's home, in two columns. The goal
 * is the server record (`useProjectGoal`): it re-reads every 60 seconds, and
 * every control writes on the revision the page shows.
 *
 * The main column: the outcome, a blocked or failed-control banner, the
 * question it waits on (answered in place), its context from GOAL.md, the
 * done criteria (verified by the independent check, or only reported met by
 * the agent), and the activity feed from the goal's events.
 *
 * The rail: state, agent, next and last check, wakes today against the cap,
 * who it waits on, sessions against the cap, who can see it, the folder.
 *
 * Controls come from `goal.capabilities`: a person who may not pause, stop or
 * answer sees no such control. Each control shows pending, success (a toast)
 * and error (a banner with a retry that finishes it). A `409` means the goal
 * changed under the page: the page shows the goal as it is now and says so.
 *
 * `legacy` is the old `/goals/<scope>/<slug>` link: it opens the goal when
 * the slug names exactly one goal.
 */
export function GoalDetail({ projectId, goalId, legacy }: { projectId: string; goalId?: string; legacy?: { scope: string; slug: string } }) {
  if (legacy) return <LegacyGoalLink projectId={projectId} scope={legacy.scope} slug={legacy.slug} />;
  return <GoalPage projectId={projectId} goalId={goalId ?? ''} />;
}

/** The goal page frame: the header (title, breadcrumb, controls) over a scrolling body. */
function GoalFrame({ projectId, title, controls, children }: { projectId: string; title: string; controls?: ReactNode; children: ReactNode }) {
  const t = useTranslations('goals');
  const listHref = uiRoutes().goals(projectId) ?? '#';
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader
        title={title}
        breadcrumb={
          <>
            <Link href={listHref} className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded-sm text-sm outline-none focus-visible:ring-2">
              {t('title')}
            </Link>
            <CaretRightIcon className="text-muted-foreground size-3 shrink-0" aria-hidden />
          </>
        }
      >
        {controls}
      </ProjectPageHeader>
      <div className="@container/goal min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 pb-24 md:px-10">{children}</div>
      </div>
    </div>
  );
}

function GoalSkeleton() {
  return (
    <div className="flex max-w-2xl flex-col gap-3" aria-busy>
      <Skeleton className="h-8 w-2/3 rounded-md" />
      <Skeleton className="h-4 w-1/2 rounded-md" />
      <Skeleton className="h-24 w-full rounded-md" />
    </div>
  );
}

/** No goal to show: it does not exist, or the viewer may not read it. One sentence, and the way back. */
function GoalUnavailable({ projectId, kind }: { projectId: string; kind: 'notFound' | 'noAccess' }) {
  const t = useTranslations('goals');
  const listHref = uiRoutes().goals(projectId);
  return (
    <EmptyState
      title={kind === 'notFound' ? t('notFound') : t('noAccess')}
      description={kind === 'notFound' ? t('notFoundHint') : t('noAccessHint')}
      action={
        listHref ? (
          <Button asChild size="sm" variant="outline">
            <Link href={listHref}>{t('back')}</Link>
          </Button>
        ) : undefined
      }
      data-testid={kind === 'notFound' ? 'goal-not-found' : 'goal-no-access'}
    />
  );
}

/** The old `/goals/<scope>/<slug>` link: one goal with that slug opens at its id; several ask which one; none is not found. */
function LegacyGoalLink({ projectId, scope, slug }: { projectId: string; scope: string; slug: string }) {
  const t = useTranslations('goals');
  const router = useRouter();
  const goals = useProjectGoals(projectId);
  const matches = (goals.data ?? []).filter((g) => g.slug === slug && (scope !== 'company' || g.scope === 'company'));
  const only = matches.length === 1 ? matches[0]! : null;
  const target = only ? goalHref(projectId, only) : null;
  useEffect(() => {
    if (target) router.replace(target);
  }, [router, target]);

  return (
    <GoalFrame projectId={projectId} title={t('title')}>
      {goals.isError ? (
        <ErrorState size="sm" title={t('loadError')} action={<Button size="sm" variant="outline" onClick={() => goals.refetch()}>{t('retry')}</Button>} />
      ) : goals.isLoading || target ? (
        <GoalSkeleton />
      ) : matches.length === 0 ? (
        <GoalUnavailable projectId={projectId} kind="notFound" />
      ) : (
        <section className="flex max-w-2xl flex-col gap-3" aria-label={t('chooseGoal')}>
          <p className="text-muted-foreground text-sm">{t('chooseGoal')}</p>
          <ul className="flex flex-col">
            {matches.map((g) => (
              <li key={g.goalId}>
                <Link href={goalHref(projectId, g) ?? '#'} className="hover:bg-hover focus-visible:ring-ring flex h-9 min-w-0 items-center gap-2 rounded-md px-2 text-sm outline-none focus-visible:ring-2">
                  <GoalStatusIcon state={goalIconState(g)} />
                  <span className="text-foreground min-w-0 truncate">{g.record.title}</span>
                  <span className="text-muted-foreground ml-auto min-w-0 truncate text-xs">{g.folder}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </GoalFrame>
  );
}

function GoalPage({ projectId, goalId }: { projectId: string; goalId: string }) {
  const t = useTranslations('goals');
  const query = useProjectGoal(projectId, goalId);
  const goal = query.data ?? null;
  const status = query.error instanceof ApiError ? query.error.status : null;
  const files = useProjectGoalFiles(projectId, goal);
  const actions = useGoalActions(projectId);
  const [sharing, setSharing] = useState(false);

  return (
    <GoalFrame
      projectId={projectId}
      title={goal?.record.title ?? t('title')}
      controls={goal ? <GoalControls projectId={projectId} goal={goal} actions={actions} onShare={() => setSharing(true)} /> : null}
    >
      {goal ? (
        <div className="grid grid-cols-1 gap-12 @4xl/goal:grid-cols-[minmax(0,1fr)_15rem] @4xl/goal:gap-16">
          <GoalMain projectId={projectId} goal={goal} brief={files.data?.brief ?? null} files={files.data ?? null} actions={actions} />
          <GoalRail projectId={projectId} goal={goal} onShare={() => setSharing(true)} />
        </div>
      ) : status === 404 ? (
        <GoalUnavailable projectId={projectId} kind="notFound" />
      ) : status === 403 ? (
        <GoalUnavailable projectId={projectId} kind="noAccess" />
      ) : query.isError ? (
        <ErrorState size="sm" title={t('goalLoadError')} action={<Button size="sm" variant="outline" onClick={() => query.refetch()}>{t('retry')}</Button>} />
      ) : (
        <GoalSkeleton />
      )}
      {goal ? <GoalShareModal projectId={projectId} goal={goal} open={sharing} onOpenChange={setSharing} /> : null}
    </GoalFrame>
  );
}

type GoalAction = ProjectGoalControlInput['action'];
const SUCCESS_TOAST: Record<GoalAction, string> = {
  pause: 'pausedToast',
  resume: 'resumedToast',
  stop: 'stoppedToast',
  restart: 'restartedToast',
  answer: 'answerSentToast',
};
const ERROR_TITLE: Record<GoalAction, string> = {
  pause: 'pauseError',
  resume: 'resumeError',
  stop: 'stopError',
  restart: 'restartError',
  answer: 'answerError',
};

type GoalActions = ReturnType<typeof useGoalActions>;

/**
 * One control channel for the page. `run` resolves true on success. A
 * conflict (the goal changed first) leaves the cache holding the current
 * goal and says so in a toast; any other failure is kept with its input, so
 * Retry sends the same control (an answer keeps its `answerId`: it lands once).
 */
function useGoalActions(projectId: string) {
  const t = useTranslations('goals');
  const control = useProjectGoalControl(projectId);
  const [failure, setFailure] = useState<{ input: ProjectGoalControlInput; message: string } | null>(null);
  const run = async (input: ProjectGoalControlInput): Promise<boolean> => {
    setFailure(null);
    try {
      await control.mutateAsync(input);
      if (input.action !== 'answer') successToast(t(SUCCESS_TOAST[input.action]));
      return true;
    } catch (error) {
      if (error instanceof ProjectGoalConflictError) infoToast(t('changedToast'));
      else setFailure({ input, message: error instanceof Error ? error.message : '' });
      return false;
    }
  };
  const pending: GoalAction | null = control.isPending ? (control.variables?.action ?? null) : null;
  return { run, pending, failure, retry: () => (failure ? run(failure.input) : Promise.resolve(false)), dismiss: () => setFailure(null) };
}

/** A control that failed: what failed, the server's reason, and a retry that sends it again. */
function ControlFailure({ actions }: { actions: GoalActions }) {
  const t = useTranslations('goals');
  const failure = actions.failure;
  if (!failure || failure.input.action === 'answer') return null;
  const retrying = actions.pending === failure.input.action;
  return (
    <InfoBanner
      tone="destructive"
      icon={WarningIcon}
      title={t(ERROR_TITLE[failure.input.action])}
      role="alert"
      data-testid="goal-control-error"
      action={
        <Button size="xs" variant="outline" className="gap-1.5" disabled={retrying} aria-busy={retrying} onClick={() => void actions.retry()} data-testid="goal-control-retry">
          {retrying ? <Loading className="size-3.5 shrink-0" /> : null}
          {t('retry')}
        </Button>
      }
    >
      {failure.message || null}
    </InfoBanner>
  );
}

type GoalFilesData = { brief: string | null; log: string | null; notes: string | null; verification: string | null };

/** The text `kortix goals new` and the API seed under `## Context`: it says nothing until someone writes there. */
const CONTEXT_PLACEHOLDER = "The request in the person's words, constraints, and what was learned.";

/** GOAL.md as the goal's description: no front matter, no `# title` (the page shows it), no empty seed, no `## Context` heading, no criteria list (the page shows them). */
function goalDescription(brief: string | null): string {
  // Notes for the agent (HTML comments, and the plain line goals created before it was one) are not the brief.
  // Strip comments to a fixed point, an unterminated one to the end, so no `<!--` survives a removal.
  let text = (brief ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\s*# [^\n]*\n+/, '');
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  }
  return text
    .replace(/^The Kortix API holds this goal's state[^\n]*\n*/m, '')
    .replace(CONTEXT_PLACEHOLDER, '')
    .replace(/\n## (Done criteria|Done when|Success criteria)\b[\s\S]*$/i, '')
    .trim()
    .replace(/^## Context\s*/, '')
    .trim();
}

function GoalMain({ projectId, goal, brief, files, actions }: { projectId: string; goal: ProjectGoal; brief: string | null; files: GoalFilesData | null; actions: GoalActions }) {
  const t = useTranslations('goals');
  const issueText = useGoalIssueText();
  const nextStep = useGoalBlockedNextStep();
  const record = goal.record;
  const paused = goalPaused(goal);
  const open = goal.health.state !== 'closed';
  const waiting = open && !paused && record.state === 'waiting_on_user';
  const issues = open && !paused ? goal.health.issues.filter((issue) => issue !== 'blocked') : [];
  const description = goalDescription(brief);
  const counts = goalCriteriaStatus(goal);

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <header className="flex flex-col gap-5" data-testid="goal-overview">
        <h2 className="text-foreground text-2xl font-semibold tracking-tight text-balance">{record.title}</h2>
        {description ? <GoalDescription markdown={description} /> : null}
      </header>

      <ControlFailure actions={actions} />

      {open && goal.blockedReason ? (
        <InfoBanner
          tone="warning"
          icon={WarningIcon}
          title={t('blockedTitle')}
          data-testid="goal-blocked"
          data-reason={goal.blockedReason}
          action={<BlockedAction goal={goal} actions={actions} />}
        >
          {`${issueText('blocked', goal)} ${nextStep(goal) ?? ''}`.trim()}
        </InfoBanner>
      ) : null}

      {record.provenance === 'legacy_unverified' ? (
        <InfoBanner tone="neutral" title={t('legacyUnverifiedTitle')} data-testid="goal-legacy">
          {t('legacyUnverified')}
        </InfoBanner>
      ) : null}

      {waiting ? <QuestionForYou projectId={projectId} goal={goal} /> : null}

      {issues.map((issue) => (
        <InfoBanner key={issue} tone="warning" icon={WarningIcon} title={t('attentionTitle')}>
          {issueText(issue, goal)}
        </InfoBanner>
      ))}

      <section className="flex flex-col gap-3" aria-label={t('doneWhen')} data-testid="goal-criteria">
        <SectionTitle aside={counts.total ? <span className="text-muted-foreground text-sm tabular-nums">{t('verifiedCount', { verified: counts.verified, total: counts.total })}</span> : null}>
          {t('doneWhen')}
        </SectionTitle>
        {goal.criteria.length ? <CriteriaList projectId={projectId} goal={goal} /> : <p className="text-muted-foreground text-sm">{t('noCriteria')}</p>}
      </section>

      <Activity projectId={projectId} goal={goal} files={files} />
    </div>
  );
}

/** The one control a blocked goal offers, when the viewer may use it: resume after a fix, or start it again for a lost owner. */
function BlockedAction({ goal, actions }: { goal: ProjectGoal; actions: GoalActions }) {
  const t = useTranslations('goals');
  const action: 'resume' | 'restart' | null =
    goal.blockedReason === 'owner_lost' && goal.capabilities.restart
      ? 'restart'
      : (goal.blockedReason === 'credits' || goal.blockedReason === 'storage' || goal.blockedReason === 'flag_off') && goal.capabilities.resume
        ? 'resume'
        : null;
  if (!action) return null;
  const busy = actions.pending !== null;
  return (
    <Button
      size="xs"
      variant="outline"
      className="gap-1.5"
      disabled={busy}
      aria-busy={actions.pending === action}
      onClick={() => void actions.run(action === 'restart' ? { goal, action, reason: t('restartReason') } : { goal, action })}
    >
      {actions.pending === action ? <Loading className="size-3.5 shrink-0" /> : null}
      {action === 'restart' ? t('restart') : t('resume')}
    </Button>
  );
}

/**
 * Done criteria in three states: verified (a green check: the independent
 * check passed it), reported met (a grey check: the agent says so, nobody
 * checked yet), not met (an empty circle). A failed check's note sits under
 * the criterion it failed.
 */
function CriteriaList({ projectId, goal }: { projectId: string; goal: ProjectGoal }) {
  const t = useTranslations('goals');
  const driveHref = uiRoutes().drive(projectId);
  const decided = goal.verification && goal.verification.outcome !== 'pending' && goal.verification.criteria_revision === goal.record.criteria_revision ? goal.verification : null;
  return (
    <ul className="flex flex-col gap-2.5 text-sm">
      {goal.criteria.map((c) => {
        const result = decided?.results.find((r) => r.criterion_id === c.id);
        const state = c.verified ? 'verified' : c.reported_met ? 'reported' : 'open';
        return (
          <li key={c.id} className="flex items-start gap-2.5" data-criterion-state={state}>
            {state === 'verified' ? (
              <CheckCircleIcon weight="fill" className="text-kortix-green mt-0.5 size-4 shrink-0" aria-label={t('verified')} />
            ) : state === 'reported' ? (
              <Hint label={t('reportedMetHint')} side="top">
                <span tabIndex={0} className="focus-visible:ring-ring mt-0.5 shrink-0 rounded-full outline-none focus-visible:ring-2">
                  <CheckCircleIcon className="text-muted-foreground size-4" aria-label={t('reportedMet')} />
                </span>
              </Hint>
            ) : (
              <CircleIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-label={t('notMet')} />
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-foreground">{c.text}</span>
              {state === 'reported' ? <span className="text-muted-foreground text-xs">{t('reportedMet')}</span> : null}
              {result && result.result !== 'pass' && text(result.note) ? (
                <span className="text-muted-foreground text-xs text-pretty">{t('checkFailed', { note: result.note })}</span>
              ) : null}
              {text(c.evidence) ? <EvidenceFile path={text(c.evidence)!} folder={goal.folder} driveHref={driveHref} /> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The question the goal waits on, who it waits on, and the answer box (only for a person who may answer). */
function QuestionForYou({ projectId, goal }: { projectId: string; goal: ProjectGoal }) {
  const t = useTranslations('goals');
  const personOf = useGoalPerson(projectId);
  const question = text(goal.record.waiting_on);
  const who = personOf(goal.record.assigned_user_id ?? goal.record.created_by_user_id);
  return (
    // A callout, not a section: the one place the page asks a person for something.
    <section className="bg-kortix-orange/15 flex flex-col gap-3 rounded-xl p-4" aria-label={t('questionForYou')} data-testid="goal-needs-you">
      <div className="flex items-center gap-2">
        <GoalStatusIcon state="waiting" />
        <h2 className="text-foreground text-sm font-semibold">{goal.capabilities.answer ? t('questionForYou') : t('waitingOnPerson', { person: who ?? t('anotherMember') })}</h2>
      </div>
      {question ? (
        // Agent text: links in it stay clickable; untrusted, so no HTML.
        <div className="text-foreground max-w-prose">
          <UnifiedMarkdown content={question} trust="untrusted" variant="message" className="text-base" />
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">{t('waitNoCost')}</p>
      {goal.capabilities.answer ? <MessageBox projectId={projectId} goal={goal} kind="answer" /> : null}
    </section>
  );
}

/**
 * One box, two jobs: the answer to the goal's question, or a note to the
 * owner agent while it works. Both go through `POST …/answer`, attributed to
 * the signed-in person. Each text gets one `answerId`, kept across retries
 * and replaced when the text changes, so a retry lands once. ⌘/Ctrl+Enter sends.
 */
function MessageBox({ projectId, goal, kind }: { projectId: string; goal: ProjectGoal; kind: 'answer' | 'message' }) {
  const t = useTranslations('goals');
  const actions = useGoalActions(projectId);
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState(false);
  const answerId = useRef(generateSessionId());
  const sending = actions.pending === 'answer';
  const failed = actions.failure?.input.action === 'answer';
  const send = async () => {
    const value = draft.trim();
    if (!value || sending) return;
    const ok = await actions.run({ goal, action: 'answer', text: value, answerId: answerId.current });
    if (ok) {
      setDraft('');
      setSent(true);
      answerId.current = generateSessionId();
      successToast(kind === 'answer' ? t('answerSentToast') : t('messageSentToast'));
    }
  };
  const sendLabel = kind === 'answer' ? t('sendAnswer') : t('sendMessage');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className="flex flex-col gap-2"
    >
      <InputGroup className="bg-background items-stretch rounded-xl">
        <textarea
          rows={kind === 'answer' ? 3 : 2}
          value={draft}
          readOnly={sending}
          onChange={(event) => {
            setDraft(event.target.value);
            // New words are a new answer: a retry of the old one must not carry them.
            answerId.current = generateSessionId();
            if (sent) setSent(false);
            if (failed) actions.dismiss();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
          }}
          placeholder={kind === 'answer' ? t('answerPlaceholder') : t('messagePlaceholder')}
          aria-label={kind === 'answer' ? t('answerLabel') : t('messageLabel')}
          className="text-foreground placeholder:text-muted-foreground w-full min-w-0 resize-none bg-transparent px-4 pt-4 text-sm outline-none"
          data-testid={kind === 'answer' ? 'goal-answer' : 'goal-message'}
        />
        <InputGroupAddon align="block-end" className="justify-between gap-2 px-4 pt-2 pb-3">
          {sent ? (
            <span className="text-muted-foreground text-xs" role="status">
              {kind === 'answer' ? t('answerSent') : t('messageSent')}
            </span>
          ) : (
            <span />
          )}
          <InputGroupButton
            type="submit"
            size="sm"
            variant="default"
            className="gap-1.5 rounded-lg"
            aria-label={sendLabel}
            disabled={!draft.trim() || sending}
            aria-busy={sending}
            data-testid={kind === 'answer' ? 'goal-answer-send' : 'goal-message-send'}
          >
            {sending ? <Loading className="size-3.5 shrink-0" /> : <ArrowUpIcon weight="bold" className="size-3.5" aria-hidden />}
            {failed ? t('retry') : t('send')}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {failed ? (
        <p className="text-destructive text-xs" role="alert" data-testid="goal-answer-error">
          {kind === 'answer' ? t('answerError') : t('messageError')}
          {actions.failure?.message ? ` ${actions.failure.message}` : ''}
        </p>
      ) : null}
    </form>
  );
}

type FeedItem = { key: string; at: string | null; icon: ReactNode; title: ReactNode; body?: ReactNode };

/** Events the feed leaves out: one per admitted wake says nothing a person needs. */
const QUIET_EVENTS = new Set(['wake_admitted']);

/** An event's glyph: the state it moved to, else its kind. */
function eventIcon(event: ProjectGoalEvent): ReactNode {
  if (event.kind === 'created') return <CheckCircleIcon weight="fill" className="text-kortix-green size-4" aria-hidden />;
  if (event.kind === 'paused') return <GoalStatusIcon state="paused" />;
  if (event.kind === 'blocked' || event.kind === 'wake_refused') return <GoalStatusIcon state="attention" />;
  if (event.to_state && event.to_state !== event.from_state) return <StatusGlyph status={event.to_state} />;
  return <ChatTextIcon className="text-muted-foreground size-4" aria-hidden />;
}

/**
 * What happened, oldest first: the goal's events from the API (every state
 * move, pause, answer, verification and refusal, each with who and when),
 * the agent's latest summary, and the verifier's report under the verdict.
 * The agent's own log (log.md, notes.md) opens from the heading's right.
 */
function Activity({ projectId, goal, files }: { projectId: string; goal: ProjectGoal; files: GoalFilesData | null }) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const events = useProjectGoalEvents(projectId, goal.goalId);
  const record = goal.record;
  const paused = goalPaused(goal);
  const open = goal.health.state !== 'closed';
  const waiting = open && !paused && record.state === 'waiting_on_user';
  const [logOpen, setLogOpen] = useState(false);
  const hasLog = !!(files?.log || files?.notes);
  const list = (events.data?.events ?? []).filter((e) => !QUIET_EVENTS.has(e.kind));
  const verdictAt = files?.verification ? list.findLastIndex((e) => e.kind === 'verdict') : -1;
  const items: FeedItem[] = list.map((event, index) => ({
    key: event.id,
    at: event.at,
    icon: eventIcon(event),
    title: text(event.message) ?? event.kind,
    body: index === verdictAt && files?.verification ? <VerificationReport report={files.verification} /> : undefined,
  }));
  if (record.summary) {
    items.push({ key: 'summary', at: record.last_wake_at ?? record.updated_at, icon: <ChatTextIcon weight="fill" className="text-kortix-blue size-4" aria-hidden />, title: t('feed.update'), body: record.summary });
  }

  return (
    <section className="border-border flex flex-col gap-5 border-t pt-8" aria-label={t('activity')} data-testid="goal-activity">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-foreground text-base font-semibold">{t('activity')}</h2>
        {hasLog ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground -mr-2 gap-1"
            aria-expanded={logOpen}
            aria-controls={logOpen ? 'goal-log' : undefined}
            onClick={() => setLogOpen((v) => !v)}
            data-testid="goal-log-toggle"
          >
            {t('agentLog')}
            <CaretDownIcon className={logOpen ? 'size-3 rotate-180 transition-transform motion-reduce:transition-none' : 'size-3 transition-transform motion-reduce:transition-none'} aria-hidden />
          </Button>
        ) : null}
      </div>
      {events.isError ? (
        <p className="text-muted-foreground text-sm">
          {t('eventsLoadError')}{' '}
          <button type="button" className="text-foreground focus-visible:ring-ring rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2" onClick={() => events.refetch()}>
            {t('retry')}
          </button>
        </p>
      ) : events.isLoading ? (
        <Skeleton className="h-16 w-full rounded-md" />
      ) : (
        <ol className="relative flex flex-col gap-5 text-sm">
          {/* The thread: one hairline behind the glyphs, from the first entry to the last. */}
          <span className="bg-border absolute top-2.5 bottom-2.5 left-2 w-px" aria-hidden />
          {items.map((item) => (
            <li key={item.key} className="relative flex gap-3">
              <span className="bg-background relative flex h-5 w-4 shrink-0 items-center justify-center">{item.icon}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="flex flex-wrap items-baseline gap-x-2 leading-5">
                  <span className="text-foreground font-medium">{item.title}</span>
                  {item.at ? <FeedTime at={item.at} label={formatGoalTime(item.at, locale, now)} /> : null}
                </p>
                {typeof item.body === 'string' ? <p className="text-muted-foreground max-w-prose leading-5 text-pretty whitespace-pre-line">{item.body}</p> : item.body}
              </div>
            </li>
          ))}
        </ol>
      )}
      {logOpen && hasLog ? (
        <div id="goal-log" className="border-border flex flex-col gap-6 border-t pt-6" data-testid="goal-log">
          <SectionTitle>{t('agentLog')}</SectionTitle>
          {files?.log ? <GoalLog markdown={files.log} /> : null}
          {files?.notes ? (
            <div className="flex max-w-prose flex-col gap-2">
              <SectionTitle>{t('notes')}</SectionTitle>
              <UnifiedMarkdown content={withoutTitle(files.notes)} trust="untrusted" variant="document" className="text-sm" />
            </div>
          ) : null}
        </div>
      ) : null}
      {open && !paused && !waiting && goal.capabilities.answer ? <MessageBox projectId={projectId} goal={goal} kind="message" /> : null}
    </section>
  );
}

/**
 * The properties rail: one quiet row per property, its glyph and its value:
 * state, agent, the next and last check, wakes today against the cap, who it
 * waits on, the person it is for, who can see it. Then its sessions against
 * the cap and its folder. Sticky beside the main column; under it on a narrow container.
 */
function GoalRail({ projectId, goal, onShare }: { projectId: string; goal: ProjectGoal; onShare: () => void }) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const personOf = useGoalPerson(projectId);
  const record = goal.record;
  const paused = goalPaused(goal);
  const open = goal.health.state !== 'closed';
  const waiting = open && !paused && record.state === 'waiting_on_user';
  const next = open && !paused ? goalNextWake(goal) : null;
  const lastWake = goalLastWake(goal);
  const counts = goalCriteriaStatus(goal);
  const driveHref = uiRoutes().drive(projectId);
  const folderHref = driveHref ? `${driveHref}?path=${encodeURIComponent(goal.folder)}` : null;
  const agent = text(record.agent);
  const { user } = useAuth();
  const stateLabel = paused ? t('paused') : t(`status.${record.state}`);
  const nextLabel = next
    ? waiting
      ? t('chaseAt', { time: formatGoalTime(next, locale, now) })
      : t('nextCheckAt', { time: formatGoalTime(next, locale, now) })
    : waiting
      ? t('waitNoCost')
      : t('noCheck');
  const atCap = record.wakes_today >= record.max_wakes_per_day;

  return (
    <aside className="flex min-w-0 flex-col gap-7 self-start @4xl/goal:sticky @4xl/goal:top-10" aria-label={t('properties')} data-testid="goal-properties">
      <div className="flex flex-col gap-1">
        <SectionTitle>{t('properties')}</SectionTitle>
        <ul className="flex flex-col text-sm">
          <Property icon={<GoalStatusIcon state={goalIconState(goal)} progress={counts.total ? counts.met / counts.total : 0} />}>{stateLabel}</Property>
          <Property icon={agent ? <AgentMark slug={agent} size={14} tile={16} className="ring-0" /> : <RobotlessIcon />} muted={!agent}>
            {agent ?? t('noAgent')}
          </Property>
          {waiting ? (
            <Property icon={<HourglassIcon className="size-4" aria-hidden />}>
              {t('waitingOnPerson', { person: personOf(record.assigned_user_id ?? record.created_by_user_id) ?? t('anotherMember') })}
            </Property>
          ) : null}
          {open ? (
            // Wakes and checks belong to an open goal; a done or stopped one has none to show.
            <>
            <Property icon={<ClockIcon className="size-4" aria-hidden />} muted={!next}>
              {nextLabel}
            </Property>
            <Property icon={<ClockCounterClockwiseIcon className="size-4" aria-hidden />} muted={!lastWake}>
              {lastWake ? t('lastCheckAt', { time: formatGoalTime(lastWake, locale, now) }) : t('neverChecked')}
            </Property>
            <Property icon={<LightningIcon className="size-4" aria-hidden />} muted={!atCap}>
              <span data-testid="goal-wakes-today">{t('wakesTodayCount', { count: record.wakes_today, max: record.max_wakes_per_day })}</span>
            </Property>
            </>
          ) : null}
          {record.assigned_user_id && user && record.assigned_user_id !== user.id ? (
            // Who it is for, only when that is someone else: "you" says nothing.
            <li className="flex h-8 min-w-0 items-center">
              <GoalPersonChip projectId={projectId} userId={record.assigned_user_id} />
            </li>
          ) : null}
          <li>
            {/* Who can see it: a ghost button that opens the share dialog. */}
            <button
              type="button"
              onClick={onShare}
              className="hover:bg-hover text-foreground focus-visible:ring-ring -mx-2 flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-left outline-none focus-visible:ring-2"
              aria-haspopup="dialog"
              aria-label={t('shareVisibility', { scope: t(`scope.${goal.scope}`) })}
              data-testid="goal-visibility"
            >
              <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center">
                {goal.scope === 'personal' ? <LockSimpleIcon className="size-4" aria-hidden /> : <UsersIcon className="size-4" aria-hidden />}
              </span>
              <span className="min-w-0 truncate">{t(`scope.${goal.scope}`)}</span>
            </button>
          </li>
        </ul>
      </div>

      {record.sessions.length ? (
        <div className="flex flex-col gap-1">
          <SectionTitle aside={<span className="text-muted-foreground text-sm tabular-nums">{t('ofMax', { count: record.sessions.length, max: record.max_sessions })}</span>}>
            {t('sessions')}
          </SectionTitle>
          <ul className="flex flex-col text-sm">
            {record.sessions.map((s) => (
              <li key={`${s.role}:${s.id}`}>
                <Link
                  href={uiRoutes().session(projectId, s.id)}
                  className="hover:bg-hover focus-visible:ring-ring -mx-2 flex h-8 min-w-0 items-center gap-2 rounded-md px-2 outline-none focus-visible:ring-2"
                >
                  <ChatCircleIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  <span className="text-foreground min-w-0 truncate">
                    <SessionName projectId={projectId} sessionId={s.id} />
                  </span>
                  <span className="text-muted-foreground ml-auto shrink-0 text-xs">{t(`role.${s.role}`)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {folderHref ? (
        <div className="flex flex-col gap-1">
          <SectionTitle>{t('filesLabel')}</SectionTitle>
          <Link href={folderHref} className="hover:bg-hover text-foreground focus-visible:ring-ring -mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-sm outline-none focus-visible:ring-2">
            <FolderOpenIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
            {t('openFolder')}
          </Link>
        </div>
      ) : null}
    </aside>
  );
}

/**
 * The goal's controls, from `goal.capabilities` only: Pause, Resume or Start
 * again visible (the one frequent control), the rest in one menu: the chat,
 * sharing, and Stop (behind a confirm). While a control runs every control
 * is disabled: one request at a time, and the running one shows the spinner.
 */
function GoalControls({ projectId, goal, actions, onShare }: { projectId: string; goal: ProjectGoal; actions: GoalActions; onShare: () => void }) {
  const t = useTranslations('goals');
  const router = useRouter();
  const [stopping, setStopping] = useState(false);
  const caps = goal.capabilities;
  const busy = actions.pending !== null;
  const sessionHref = goal.coordinatorSessionId ? uiRoutes().session(projectId, goal.coordinatorSessionId) : null;
  const control = (action: 'pause' | 'resume' | 'restart', icon: ReactNode, label: string) => (
    <Button
      size="xs"
      variant="secondary"
      className="gap-1.5"
      disabled={busy}
      aria-busy={actions.pending === action}
      onClick={() =>
        void actions.run(action === 'resume' ? { goal, action } : { goal, action, reason: t(action === 'pause' ? 'pauseReason' : 'restartReason') })
      }
      data-testid={`goal-${action}`}
    >
      {actions.pending === action ? <Loading className="size-3.5 shrink-0" /> : icon}
      {label}
    </Button>
  );

  return (
    <>
      {/* The visible control and the ⋯ menu: one secondary button group. */}
      <ButtonGroup>
        {caps.pause ? control('pause', <PauseIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />, t('pause')) : null}
        {caps.resume ? control('resume', <PlayIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />, t('resume')) : null}
        {caps.restart ? control('restart', <PlayIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />, t('restart')) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="secondary" aria-label={t('moreActions')} data-testid="goal-more">
              <DotsThreeIcon className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {sessionHref ? (
              <DropdownMenuItem onSelect={() => router.push(sessionHref)}>
                <ChatCircleIcon aria-hidden />
                {t('openSession')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={onShare}>
              <ShareNetworkIcon aria-hidden />
              {t('share')}
            </DropdownMenuItem>
            {caps.stop ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => setStopping(true)} data-testid="goal-stop">
                  <StopIcon aria-hidden />
                  {t('stop')}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
      <ConfirmDialog
        open={stopping}
        onOpenChange={(next) => actions.pending !== 'stop' && setStopping(next)}
        title={t('stopTitle')}
        description={t('stopDescription')}
        confirmLabel={t('stop')}
        confirmVariant="destructive"
        isPending={actions.pending === 'stop'}
        onConfirm={async () => {
          // Success or failure, the dialog closes: a failure shows its banner with a retry on the page.
          await actions.run({ goal, action: 'stop', reason: t('stopReason') });
          setStopping(false);
        }}
      />
    </>
  );
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="text-muted-foreground flex items-center gap-2 text-sm font-medium">{children}</h2>
      {aside}
    </div>
  );
}

/** Characters past which the description starts folded: an agent's working notes can run to pages. */
const LONG_CONTEXT = 700;

/** The goal's description from GOAL.md, right under the title, folded to its first lines when it is long. */
function GoalDescription({ markdown }: { markdown: string }) {
  const t = useTranslations('goals');
  const long = markdown.length > LONG_CONTEXT;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-2" data-testid="goal-context">
      <div className={long && !expanded ? 'max-w-prose max-h-56 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]' : 'max-w-prose'}>
        <UnifiedMarkdown content={markdown} trust="untrusted" variant="document" className="text-base" />
      </div>
      {long ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground w-fit text-sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          data-testid="goal-context-toggle"
        >
          {expanded ? t('showLess') : t('showMore')}
        </button>
      ) : null}
    </div>
  );
}

/** The exact local date and time, for a hint: "Wednesday, November 4, 2026 at 11:22:06 PM GMT+5:30". */
function exactTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: 'full', timeStyle: 'long' });
}

/** A feed entry's relative time; hover or focus shows the exact date and time. */
function FeedTime({ at, label }: { at: string; label: string }) {
  const locale = useLocale();
  return (
    <Hint label={exactTime(at, locale)} side="top" align="start" alignOffset={0} sideOffset={6}>
      <time dateTime={at} tabIndex={0} className="text-muted-foreground focus-visible:ring-ring rounded-sm text-xs whitespace-nowrap tabular-nums outline-none focus-visible:ring-2">
        {label}
      </time>
    </Hint>
  );
}

/** A log time in the reader's time zone: "Nov 4, 11:22 PM"; the year only when it is not this one. */
function formatLogTime(iso: string, locale: string, now: number): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleString(locale, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The agent's log in file order: a timed line is a row (its local time, then what happened); other Markdown stays as written. */
function GoalLog({ markdown }: { markdown: string }) {
  const locale = useLocale();
  const now = useGoalClock();
  return (
    <div className="flex max-w-prose flex-col gap-2 text-sm">
      {parseGoalLog(markdown).map((block, index) =>
        block.kind === 'entry' ? (
          <div key={`${block.at}:${index}`} className="flex gap-4">
            <Hint label={exactTime(block.at, locale)} side="top" align="start" alignOffset={0} sideOffset={6}>
              <time dateTime={block.at} className="text-muted-foreground min-w-32 shrink-0 leading-6 whitespace-nowrap tabular-nums">
                {formatLogTime(block.at, locale, now)}
              </time>
            </Hint>
            <div className="text-foreground min-w-0 flex-1">
              <UnifiedMarkdown content={block.text} trust="untrusted" variant="message" className="text-sm" />
            </div>
          </div>
        ) : (
          <div key={`text:${index}`} className="py-1">
            <UnifiedMarkdown content={block.markdown} trust="untrusted" variant="document" className="text-sm" />
          </div>
        ),
      )}
    </div>
  );
}

/** A state move's glyph: the goal status icon of the state it moved to. */
function StatusGlyph({ status }: { status: ProjectGoalStatus }) {
  // Work in motion reads blue in the feed; done, waiting and closed keep the icon's own color.
  const moving = status === 'active' || status === 'verifying';
  return <GoalStatusIcon state={goalStatusIconState(status)} progress={0} tone={moving ? 'var(--kortix-blue)' : undefined} />;
}

/** The verifier's report, folded behind "Show report". */
function VerificationReport({ report }: { report: string }) {
  const t = useTranslations('goals');
  const [open, setOpen] = useState(false);
  return (
    <Disclosure open={open} onOpenChange={setOpen}>
      <DisclosureTrigger>
        <button type="button" className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs" data-testid="goal-report-toggle">
          <CaretRightIcon className="size-3 transition-transform data-[open=true]:rotate-90" data-open={open} aria-hidden />
          {open ? t('hideReport') : t('showReport')}
        </button>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="max-w-prose pt-2">
          <UnifiedMarkdown content={withoutTitle(report)} trust="untrusted" variant="message" className="text-sm" />
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}

/** A glyph-first property row: the glyph in a fixed 16 px slot, then the value. */
function Property({ icon, children, muted }: { icon: ReactNode; children: ReactNode; muted?: boolean }) {
  return (
    <li className="flex h-8 min-w-0 items-center gap-2">
      <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className={muted ? 'text-muted-foreground min-w-0 truncate' : 'text-foreground min-w-0 truncate'}>{children}</span>
    </li>
  );
}

/** No agent assigned: an empty circle in the agent slot. */
function RobotlessIcon() {
  return <CircleDashedIcon className="size-4" aria-hidden />;
}

/**
 * A GOAL.md value as text, or null. The front matter is hand-editable and the parser keeps
 * values as written: a number, list or map must never reach a React child or a string helper.
 */
function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** A goal file under its own heading: drop the file's leading `# Title`. */
function withoutTitle(markdown: string): string {
  return markdown.replace(/^\s*# [^\n]*\n+/, '');
}

/** A session's display name, or its id until the row loads (or when it is gone). */
function SessionName({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useProjectSession(projectId, sessionId);
  return <>{session.data?.name || sessionId}</>;
}

/** A folder action: the shared ghost icon button, labelled with what it opens. */
function OpenFolderAction({ href, file }: { href: string; file: string }) {
  const t = useTranslations('goals');
  return (
    <Hint label={t('openInFiles')}>
      <Button asChild variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground shrink-0">
        <Link href={href} aria-label={t('openFolderOf', { file })}>
          <FolderOpenIcon className="size-3.5" aria-hidden />
        </Link>
      </Button>
    </Hint>
  );
}

/** An evidence file: its name, and a way to its folder in Files that says it opens the folder. */
function EvidenceFile({ path, folder, driveHref }: { path: string; folder: string; driveHref: string | null }) {
  const parent = `${folder}/${path}`.split('/').slice(0, -1).join('/');
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
      <span className="min-w-0 truncate">{path}</span>
      {driveHref ? <OpenFolderAction href={`${driveHref}?path=${encodeURIComponent(parent)}`} file={path} /> : null}
    </span>
  );
}

