'use client';

import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@kortix/ui/disclosure';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@kortix/ui/dropdown-menu';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { Hint } from '@kortix/ui/hint';
import { InfoBanner } from '@kortix/ui/info-banner';
import { AgentMark } from '@kortix/ui/internal/components/agent-mark';
import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Skeleton } from '@kortix/ui/skeleton';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast, successToast } from '@kortix/ui/toast';
import { uiRoutes } from '@kortix/ui';
import {
  formatGoalTime,
  GoalCriteriaProgress,
  goalLastWake,
  goalOpenAsks,
  goalPaused,
  GoalPersonChip,
  GoalStatusBadge,
  ProjectPageHeader,
  useGoalClock,
  useGoalIssueText,
  useGoalStateText,
} from '@kortix/ui/workspace';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  pauseProjectGoal,
  replyToProjectGoal,
  resumeProjectGoal,
  stopProjectGoal,
  type ProjectGoal,
  type ProjectGoalStatus,
} from '@kortix/sdk';
import { useProjectGoalFiles, useProjectGoals, useProjectSession } from '@kortix/sdk/react';
import { useMutation } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  CaretRightIcon,
  ChatCircleIcon,
  ChatTextIcon,
  CheckCircleIcon,
  CircleIcon,
  DotsThreeIcon,
  FileIcon,
  FolderOpenIcon,
  LinkIcon,
  PauseIcon,
  PlayIcon,
  ShareNetworkIcon,
  StopIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { FolderAccessPanel } from '@/features/drives/folder-access-panel';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

/**
 * /projects/[id]/goals/[scope]/[slug] — one goal's home, in two columns.
 *
 * The main column reads top to bottom: the outcome, where it stands (or the
 * question it waits on, answered in place), its context, the done criteria
 * with evidence, what it produced, and the activity feed. The feed ends with
 * a message box to the owner agent (`replyToProjectGoal`).
 *
 * The rail lists its properties: state, progress, agent, the person it is
 * for, the next and last check, its limits, and its sessions. On a narrow
 * container the rail moves under the main column.
 *
 * A person pauses or resumes it (header) or stops it (⋯). Everything is read
 * from the goal folder in Files and its heartbeat loop.
 */
export function GoalDetail({ projectId, scope, slug }: { projectId: string; scope: string; slug: string }) {
  const t = useTranslations('goals');
  const goals = useProjectGoals(projectId);
  const goal = goals.data?.find((g) => g.scope === scope && g.slug === slug) ?? null;
  const files = useProjectGoalFiles(projectId, goal);
  const listHref = uiRoutes().goals(projectId) ?? '#';
  const refetch = () => goals.refetch();

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={t('title')}>{goal ? <GoalControls projectId={projectId} goal={goal} onChanged={refetch} /> : null}</ProjectPageHeader>
      <div className="@container/goal min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 pb-20 md:px-8">
          <Link href={listHref} className="text-muted-foreground hover:text-foreground mb-6 flex w-fit items-center gap-1 text-xs">
            <ArrowLeftIcon className="size-3" aria-hidden />
            {t('back')}
          </Link>
          {goals.isError ? (
            <ErrorState
              size="sm"
              title={t('loadError')}
              action={
                <Button size="sm" variant="outline" onClick={refetch}>
                  {t('retry')}
                </Button>
              }
            />
          ) : goals.isLoading ? (
            <div className="flex max-w-2xl flex-col gap-3">
              <Skeleton className="h-7 w-2/3 rounded-md" />
              <Skeleton className="h-4 w-1/2 rounded-md" />
              <Skeleton className="h-24 w-full rounded-md" />
            </div>
          ) : !goal ? (
            <EmptyState title={t('notFound')} />
          ) : (
            <div className="grid grid-cols-1 gap-10 @4xl/goal:grid-cols-[minmax(0,1fr)_17rem] @4xl/goal:gap-12">
              <GoalMain projectId={projectId} goal={goal} files={files.data ?? null} onChanged={refetch} />
              <GoalRail projectId={projectId} goal={goal} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-muted-foreground flex items-center gap-2 text-xs font-medium">{children}</h2>
      {aside}
    </div>
  );
}

type GoalFilesData = { log: string | null; notes: string | null; verification: string | null };

/** The text `kortix goals new` and `createProjectGoal` seed under `## Context`: it says nothing until someone writes there. */
const CONTEXT_PLACEHOLDER = "The request in the person's words, constraints, and what was learned.";

/** GOAL.md's body as the goal's description: without its `# title` (the page shows it), the empty seed, or a heading left with nothing under it. */
function goalDescription(body: string | undefined): string {
  // The section heading already says "Context": drop the file's own.
  return (body ?? '')
    .replace(/^\s*# [^\n]*\n+/, '')
    .replace(CONTEXT_PLACEHOLDER, '')
    .trim()
    .replace(/^## Context\s*/, '')
    .trim();
}

/** Characters past which the context starts folded: an agent's working notes can run to pages. */
const LONG_CONTEXT = 700;

/** The goal's context from GOAL.md, folded to its first lines when it is long. */
function GoalContext({ markdown }: { markdown: string }) {
  const t = useTranslations('goals');
  const long = markdown.length > LONG_CONTEXT;
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="flex flex-col gap-3" aria-label={t('context')} data-testid="goal-context">
      <SectionTitle>{t('context')}</SectionTitle>
      <div className={long && !expanded ? 'max-w-prose max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]' : 'max-w-prose'}>
        <UnifiedMarkdown content={markdown} trust="untrusted" variant="document" className="text-sm" />
      </div>
      {long ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground w-fit text-xs"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          data-testid="goal-context-toggle"
        >
          {expanded ? t('showLess') : t('showMore')}
        </button>
      ) : null}
    </section>
  );
}

function GoalMain({ projectId, goal, files, onChanged }: { projectId: string; goal: ProjectGoal; files: GoalFilesData | null; onChanged: () => Promise<unknown> }) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const stateText = useGoalStateText();
  const issueText = useGoalIssueText();
  const doc = goal.goal;
  const paused = goalPaused(goal);
  const open = goal.health.state !== 'closed';
  const waiting = open && !paused && (doc?.status === 'waiting_on_user' || goalOpenAsks(doc).length > 0);
  const issues = open && !paused ? goal.health.issues : [];
  const description = goalDescription(doc?.body);
  // Results: what the goal produced, minus the evidence files Done when already cites.
  const cited = new Set((doc?.success_criteria ?? []).map((c) => c.evidence).filter(Boolean));
  const results = (doc?.links ?? []).filter((link) => !cited.has(link));

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <header className="flex flex-col gap-3" data-testid="goal-overview">
        <h1 className="text-foreground text-xl font-medium tracking-tight text-balance">{doc?.objective ?? goal.slug}</h1>
        {waiting ? null : (
          <p className="text-muted-foreground text-sm text-pretty" data-testid="goal-state">
            {stateText(goal, locale, now)}
          </p>
        )}
      </header>

      {waiting ? <QuestionForYou projectId={projectId} goal={goal} onChanged={onChanged} /> : null}

      {description ? <GoalContext markdown={description} /> : null}

      {issues.map((issue) => (
        <InfoBanner key={issue} tone="warning" icon={WarningIcon} title={t('attentionTitle')}>
          {issueText(issue, goal)}
        </InfoBanner>
      ))}

      <section className="flex flex-col gap-3" aria-label={t('doneWhen')} data-testid="goal-criteria">
        <SectionTitle aside={<GoalCriteriaProgress goal={doc} />}>{t('doneWhen')}</SectionTitle>
        {doc?.success_criteria?.length ? <CriteriaList projectId={projectId} goal={goal} /> : <p className="text-muted-foreground text-sm">{t('noCriteria')}</p>}
      </section>

      {results.length ? (
        <section className="flex flex-col gap-3" aria-label={t('results')}>
          <SectionTitle>{t('results')}</SectionTitle>
          <ul className="flex flex-col gap-1.5 text-sm">
            {results.map((link) => (
              <li key={link} className="min-w-0">
                <LinkTarget link={link} folder={goal.folder} driveHref={uiRoutes().drive(projectId)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Activity projectId={projectId} goal={goal} files={files} onChanged={onChanged} />
    </div>
  );
}

/** Done criteria: a green check with its evidence, or an empty circle. */
function CriteriaList({ projectId, goal }: { projectId: string; goal: ProjectGoal }) {
  const t = useTranslations('goals');
  const driveHref = uiRoutes().drive(projectId);
  return (
    <ul className="flex flex-col gap-2.5 text-sm">
      {(goal.goal?.success_criteria ?? []).map((c) => (
        <li key={c.id} className="flex items-start gap-2.5">
          {c.met ? (
            <CheckCircleIcon weight="fill" className="text-kortix-green mt-0.5 size-4 shrink-0" aria-label={t('met')} />
          ) : (
            <CircleIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-label={t('notMet')} />
          )}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-foreground">{c.text}</span>
            {c.evidence ? <EvidenceFile path={c.evidence} folder={goal.folder} driveHref={driveHref} /> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The question the goal waits on and the answer box: the answer goes to the owner session, which wakes on it. */
function QuestionForYou({ projectId, goal, onChanged }: { projectId: string; goal: ProjectGoal; onChanged: () => Promise<unknown> }) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const doc = goal.goal;
  const asks = goalOpenAsks(doc);
  const question = (doc?.status === 'waiting_on_user' ? doc.waiting_on : null) ?? asks[0]?.title ?? null;
  const otherAsks = doc?.status === 'waiting_on_user' && doc.waiting_on ? asks : asks.slice(1);
  return (
    <section className="flex flex-col gap-3" aria-label={t('questionForYou')} data-testid="goal-needs-you">
      <SectionTitle>
        <span className="bg-kortix-orange size-1.5 rounded-full" aria-hidden />
        {t('questionForYou')}
      </SectionTitle>
      {question ? (
        // Agent text: links in it stay clickable; untrusted, so no HTML.
        <div className="max-w-prose">
          <UnifiedMarkdown content={question} trust="untrusted" variant="message" className="text-sm" />
        </div>
      ) : null}
      {otherAsks.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {otherAsks.map((ask) => (
            <li key={ask.id} className="flex items-baseline justify-between gap-3">
              <span className="text-foreground min-w-0">{ask.title}</span>
              {ask.due ? <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{t('due', { time: formatGoalTime(ask.due, locale, now) })}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <MessageBox projectId={projectId} goal={goal} onChanged={onChanged} kind="answer" />
    </section>
  );
}

/**
 * One box, two jobs: the answer to the goal's question, or a note to the owner
 * agent while it works. Either way the text goes to the owner session, which
 * wakes on it. ⌘/Ctrl+Enter sends.
 */
function MessageBox({ projectId, goal, onChanged, kind }: { projectId: string; goal: ProjectGoal; onChanged: () => Promise<unknown>; kind: 'answer' | 'message' }) {
  const t = useTranslations('goals');
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const send = useMutation({
    mutationFn: () => replyToProjectGoal(projectId, goal, text.trim()),
    onSuccess: () => {
      setText('');
      setSent(true);
      successToast(kind === 'answer' ? t('answerSentToast') : t('messageSentToast'));
      void onChanged();
    },
    onError: () => errorToast(kind === 'answer' ? t('answerError') : t('messageError')),
  });
  if (!goal.coordinatorSessionId) return null;
  const sendLabel = kind === 'answer' ? t('sendAnswer') : t('sendMessage');
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() && !send.isPending) send.mutate();
      }}
    >
      <Textarea
        rows={kind === 'answer' ? 3 : 2}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (sent) setSent(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
        }}
        placeholder={kind === 'answer' ? t('answerPlaceholder') : t('messagePlaceholder')}
        aria-label={kind === 'answer' ? t('answerLabel') : t('messageLabel')}
        data-testid={kind === 'answer' ? 'goal-answer' : 'goal-message'}
      />
      <div className="flex items-center justify-between gap-2">
        {sent ? (
          <p className="text-muted-foreground text-xs" role="status">
            {kind === 'answer' ? t('answerSent') : t('messageSent')}
          </p>
        ) : (
          <span />
        )}
        <Button
          type="submit"
          size="sm"
          variant={kind === 'answer' ? 'default' : 'outline'}
          className="gap-1.5"
          disabled={!text.trim() || send.isPending}
          aria-busy={send.isPending}
          data-testid={kind === 'answer' ? 'goal-answer-send' : 'goal-message-send'}
        >
          <ArrowUpIcon className="size-3.5 shrink-0" aria-hidden />
          {sendLabel}
        </Button>
      </div>
    </form>
  );
}

type FeedItem = { key: string; at: string | null; order: number; icon: ReactNode; title: ReactNode; body?: ReactNode };

/**
 * What happened, oldest first: every state move, a pause, the independent
 * check, and the agent's latest update. While the goal runs it ends with the
 * message box; the full log folds underneath.
 */
function Activity({ projectId, goal, files, onChanged }: { projectId: string; goal: ProjectGoal; files: GoalFilesData | null; onChanged: () => Promise<unknown> }) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const doc = goal.goal;
  const paused = goalPaused(goal);
  const open = goal.health.state !== 'closed';
  const waiting = open && !paused && (doc?.status === 'waiting_on_user' || goalOpenAsks(doc).length > 0);
  const [logOpen, setLogOpen] = useState(false);
  const transitions = doc?.transitions ?? [];
  const updatedAt = goalLastWake(goal) ?? transitions.at(-1)?.at ?? null;

  // The verifier's report folds under the move it decided: out of verifying, to done or back to active.
  const verdict = files?.verification ? transitions.findLastIndex((tr) => tr.from === 'verifying') : -1;
  const items: FeedItem[] = transitions.map((tr, index) => ({
    key: `t:${tr.at}:${index}`,
    at: tr.at,
    order: index,
    icon: <StatusGlyph status={tr.to} />,
    title: tr.from === null ? t('feed.created') : t('feed.moved', { status: t(`status.${tr.to}`) }),
    body:
      index === verdict && files?.verification ? (
        <VerificationReport report={files.verification} />
      ) : tr.reason && tr.to !== 'done' && tr.from !== null ? (
        tr.reason
      ) : undefined,
  }));
  if (doc?.summary) {
    items.push({ key: 'summary', at: updatedAt, order: transitions.length + 1, icon: <ChatTextIcon className="text-muted-foreground size-4" aria-hidden />, title: t('feed.update'), body: doc.summary });
  }
  if (paused && doc?.paused_at) {
    items.push({ key: 'paused', at: doc.paused_at, order: transitions.length + 2, icon: <PauseIcon className="text-muted-foreground size-4" aria-hidden />, title: t('feed.paused') });
  }
  items.sort((a, b) => a.order - b.order);

  return (
    <section className="flex flex-col gap-4" aria-label={t('activity')} data-testid="goal-activity">
      <SectionTitle>{t('activity')}</SectionTitle>
      <ol className="relative flex flex-col gap-4 text-sm">
        {/* The thread: one hairline behind the glyphs, from the first entry to the last. */}
        <span className="bg-border absolute top-2 bottom-2 left-2 w-px" aria-hidden />
        {items.map((item) => (
          <li key={item.key} className="relative flex gap-3">
            <span className="bg-background relative mt-0.5 flex size-4 shrink-0 items-center justify-center">{item.icon}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="text-foreground">
                {item.title}
                {item.at ? <span className="text-muted-foreground whitespace-nowrap tabular-nums"> · {formatGoalTime(item.at, locale, now)}</span> : null}
              </p>
              {typeof item.body === 'string' ? <p className="text-muted-foreground max-w-prose text-pretty whitespace-pre-line">{item.body}</p> : item.body}
            </div>
          </li>
        ))}
      </ol>
      {open && !paused && !waiting ? <MessageBox projectId={projectId} goal={goal} onChanged={onChanged} kind="message" /> : null}
      {files?.log || files?.notes ? (
        <Disclosure open={logOpen} onOpenChange={setLogOpen}>
          <DisclosureTrigger>
            <button type="button" className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs" data-testid="goal-log-toggle">
              <CaretRightIcon className="size-3 transition-transform data-[open=true]:rotate-90" data-open={logOpen} aria-hidden />
              {logOpen ? t('hideLog') : t('showLog')}
            </button>
          </DisclosureTrigger>
          <DisclosureContent>
            <div className="flex flex-col gap-6 pt-3">
              {files?.log ? <UnifiedMarkdown content={withoutTitle(files.log)} trust="untrusted" variant="document" className="text-sm" /> : null}
              {files?.notes ? (
                <div className="flex flex-col gap-2">
                  <SectionTitle>{t('notes')}</SectionTitle>
                  <UnifiedMarkdown content={withoutTitle(files.notes)} trust="untrusted" variant="document" className="text-sm" />
                </div>
              ) : null}
            </div>
          </DisclosureContent>
        </Disclosure>
      ) : null}
    </section>
  );
}

/** A state move's glyph: green check for done, orange dot for waiting on a person, a stop square for stopped, grey otherwise. */
function StatusGlyph({ status }: { status: ProjectGoalStatus }) {
  if (status === 'done') return <CheckCircleIcon weight="fill" className="text-kortix-green size-4" aria-hidden />;
  if (status === 'stopped' || status === 'abandoned') return <StopIcon className="text-muted-foreground size-3.5" aria-hidden />;
  return <span className={status === 'waiting_on_user' ? 'bg-kortix-orange size-2 rounded-full' : 'bg-muted-foreground size-2 rounded-full'} aria-hidden />;
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
        <div className="pt-2">
          <UnifiedMarkdown content={withoutTitle(report)} trust="untrusted" variant="message" className="text-sm" />
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}

/**
 * The properties rail: state, progress, agent, the person it is for, when it
 * checks next and last, its limits, and its sessions. Sticky beside the main
 * column; under it on a narrow container.
 */
function GoalRail({ projectId, goal }: { projectId: string; goal: ProjectGoal }) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const doc = goal.goal;
  const paused = goalPaused(goal);
  const open = goal.health.state !== 'closed';
  const heartbeat = goal.heartbeat;
  const today = new Date(now).toISOString().slice(0, 10);
  const scheduled = open && !paused && heartbeat?.state === 'active' && !!heartbeat.next_fire_at;
  // One empty value, "—", for every property with nothing to show (closed, paused, nothing scheduled).
  const nextCheck = scheduled ? formatGoalTime(heartbeat!.next_fire_at, locale, now) : '—';
  const driveHref = uiRoutes().drive(projectId);
  const folderHref = driveHref ? `${driveHref}?path=${encodeURIComponent(goal.folder)}` : null;

  return (
    <aside className="flex min-w-0 flex-col gap-8 self-start @4xl/goal:sticky @4xl/goal:top-6" aria-label={t('properties')} data-testid="goal-properties">
      <div className="flex flex-col gap-3">
        <SectionTitle>{t('properties')}</SectionTitle>
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-sm">
          <Property label={t('stateLabel')}>
            <GoalStatusBadge status={doc?.status} paused={paused} />
          </Property>
          <Property label={t('assignedAgent')}>
            {doc?.agent ? (
              <span className="flex min-w-0 items-center gap-2">
                <AgentMark slug={doc.agent} size={14} />
                <span className="text-foreground truncate">{doc.agent}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Property>
          <Property label={t('assignedUser')}>
            <GoalPersonChip projectId={projectId} userId={doc?.assigned_user} />
          </Property>
          <Property label={t('nextCheck')}>
            <span className={scheduled ? 'text-foreground tabular-nums' : 'text-muted-foreground'}>{nextCheck}</span>
          </Property>
          <Property label={t('lastCheck')}>
            <span className={goalLastWake(goal) ? 'text-foreground tabular-nums' : 'text-muted-foreground'}>{formatGoalTime(goalLastWake(goal), locale, now)}</span>
          </Property>
          {doc?.format === 'goal.md' ? (
            <>
              <Property label={t('wakesToday')}>
                <span className="text-foreground tabular-nums">
                  {t('ofMax', { count: doc.wake_day === today ? (doc.wake_count ?? 0) : 0, max: doc.max_wakes_per_day ?? 12 })}
                </span>
              </Property>
            </>
          ) : null}
          <Property label={t('scopeLabel')}>
            <span className="text-foreground">{t(`scope.${goal.scope}`)}</span>
          </Property>
        </dl>
      </div>

      {doc?.sessions?.length ? (
        <div className="flex flex-col gap-3">
          <SectionTitle
            aside={
              doc.format === 'goal.md' ? (
                <span className="text-muted-foreground text-xs tabular-nums">{t('ofMax', { count: doc.sessions.length, max: doc.max_sessions ?? 10 })}</span>
              ) : null
            }
          >
            {t('sessions')}
          </SectionTitle>
          <ul className="flex flex-col gap-2 text-sm">
            {doc.sessions.map((s) => (
              <li key={`${s.role}:${s.id}`} className="flex min-w-0 items-baseline gap-2">
                <Link href={uiRoutes().session(projectId, s.id)} className="text-foreground min-w-0 truncate hover:underline">
                  <SessionName projectId={projectId} sessionId={s.id} />
                </Link>
                <span className="text-muted-foreground shrink-0 text-xs">{t(`role.${s.role}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {folderHref ? (
        <Button asChild variant="outline" size="sm" className="w-fit gap-1.5">
          <Link href={folderHref}>
            <FolderOpenIcon className="size-3.5 shrink-0" aria-hidden />
            {t('openFolder')}
          </Link>
        </Button>
      ) : null}
    </aside>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-h-6 min-w-0 items-center">{children}</dd>
    </>
  );
}

function useResume(projectId: string, goal: ProjectGoal, onChanged: () => Promise<unknown>) {
  const t = useTranslations('goals');
  return useMutation({
    mutationFn: () => resumeProjectGoal(projectId, goal),
    // The control stays busy until the page shows the new state, then the toast reports it.
    onSuccess: async () => {
      await onChanged();
      successToast(t('resumedToast'));
    },
    onError: () => errorToast(t('resumeError')),
  });
}

/**
 * The goal's controls: Pause or Resume visible (the one frequent control),
 * the rest in one menu: the chat, sharing, and Stop.
 */
function GoalControls({ projectId, goal, onChanged }: { projectId: string; goal: ProjectGoal; onChanged: () => Promise<unknown> }) {
  const t = useTranslations('goals');
  const router = useRouter();
  const [stopping, setStopping] = useState(false);
  const [sharing, setSharing] = useState(false);
  const open = goal.health.state !== 'closed';
  const writable = open && goal.goal?.format === 'goal.md';
  const paused = goalPaused(goal);
  const driveHref = uiRoutes().drive(projectId);
  const folderHref = driveHref ? `${driveHref}?path=${encodeURIComponent(goal.folder)}` : null;
  const sessionHref = goal.coordinatorSessionId ? uiRoutes().session(projectId, goal.coordinatorSessionId) : null;
  const resume = useResume(projectId, goal, onChanged);
  const pause = useMutation({
    mutationFn: () => pauseProjectGoal(projectId, goal, t('pauseReason')),
    onSuccess: async () => {
      await onChanged();
      successToast(t('pausedToast'));
    },
    onError: () => errorToast(t('pauseError')),
  });
  const stop = useMutation({
    mutationFn: () => stopProjectGoal(projectId, goal, t('stopReason')),
    onSuccess: async () => {
      await onChanged();
      setStopping(false);
      successToast(t('stoppedToast'));
    },
    onError: () => errorToast(t('stopError')),
  });

  return (
    <>
      {writable && !paused ? (
        <Button size="sm" variant="outline" className="gap-1.5" disabled={pause.isPending} aria-busy={pause.isPending} onClick={() => pause.mutate()} data-testid="goal-pause">
          <PauseIcon className="size-3.5 shrink-0" aria-hidden />
          {t('pause')}
        </Button>
      ) : null}
      {writable && paused ? (
        <Button size="sm" variant="outline" className="gap-1.5" disabled={resume.isPending} aria-busy={resume.isPending} onClick={() => resume.mutate()} data-testid="goal-resume">
          <PlayIcon className="size-3.5 shrink-0" aria-hidden />
          {t('resume')}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={t('moreActions')} data-testid="goal-more">
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
          <DropdownMenuItem onSelect={() => setSharing(true)}>
            <ShareNetworkIcon aria-hidden />
            {t('share')}
          </DropdownMenuItem>
          {writable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setStopping(true)} data-testid="goal-stop">
                <StopIcon aria-hidden />
                {t('stop')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={stopping}
        onOpenChange={setStopping}
        title={t('stopTitle')}
        description={t('stopDescription')}
        confirmLabel={t('stop')}
        confirmVariant="destructive"
        isPending={stop.isPending}
        onConfirm={() => stop.mutate()}
      />
      <Modal open={sharing} onOpenChange={setSharing}>
        <ModalContent className="lg:max-w-md">
          <ModalHeader>
            <ModalTitle>{t('shareTitle')}</ModalTitle>
          </ModalHeader>
          <ModalBody>
            <FolderAccessPanel
              driveId={goal.driveId}
              path={goal.folder}
              onManage={() => {
                setSharing(false);
                if (folderHref) router.push(folderHref);
              }}
            />
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
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

/** A URL as its last path segment (or its host) and its host; the full URL stays in the link's title. */
function urlLabel(link: string): { name: string; host: string } {
  try {
    const url = new URL(link);
    const last = url.pathname.split('/').filter(Boolean).at(-1);
    return { name: last ? decodeURIComponent(last) : url.host, host: url.host };
  } catch {
    return { name: link, host: '' };
  }
}

/**
 * A `links:` entry: a URL opens as is. A path in Files shows its name and its
 * folder, plus a folder action that opens that folder in Files (the same row
 * as an evidence file). A path inside a session's sandbox (`/workspace`,
 * `/drives`) is not in Files: it shows muted, with no action.
 */
function LinkTarget({ link, folder, driveHref }: { link: string; folder: string; driveHref: string | null }) {
  if (/^https?:\/\//.test(link)) {
    return (
      <a href={link} target="_blank" rel="noreferrer" title={link} className="flex min-w-0 items-center gap-2 underline-offset-2 hover:underline">
        <LinkIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <span className="text-foreground shrink-0">{urlLabel(link).name}</span>
        <span className="text-muted-foreground min-w-0 truncate text-xs">{urlLabel(link).host}</span>
      </a>
    );
  }
  const path = link.startsWith('/') ? link : `${folder}/${link}`;
  const name = path.split('/').at(-1) ?? path;
  const parent = path.split('/').slice(0, -1).join('/') || '/';
  const inFiles = !!driveHref && !/^\/(workspace|drives)\//.test(link);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <FileIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <span className={inFiles ? 'text-foreground shrink-0' : 'text-muted-foreground shrink-0'}>{name}</span>
      <span className="text-muted-foreground min-w-0 truncate text-xs">{link.startsWith('/') ? parent : link.split('/').slice(0, -1).join('/')}</span>
      {inFiles ? <OpenFolderAction href={`${driveHref}?path=${encodeURIComponent(parent)}`} file={name} /> : null}
    </span>
  );
}
