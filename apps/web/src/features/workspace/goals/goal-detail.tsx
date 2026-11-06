'use client';

import { Button } from '@kortix/ui/button';
import { ButtonGroup } from '@kortix/ui/button-group';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@kortix/ui/disclosure';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@kortix/ui/dropdown-menu';
import { EmptyState } from '@kortix/ui/empty-state';
import { FaviconAvatar } from '@kortix/ui/favicon-avatar';
import { ErrorState } from '@kortix/ui/error-state';
import { Hint } from '@kortix/ui/hint';
import { InfoBanner } from '@kortix/ui/info-banner';
import { InputGroup, InputGroupAddon, InputGroupButton } from '@kortix/ui/input-group';
import { AgentMark } from '@kortix/ui/internal/components/agent-mark';
import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast, successToast } from '@kortix/ui/toast';
import { uiRoutes } from '@kortix/ui';
import {
  formatGoalTime,
  goalIconState,
  goalLastWake,
  goalOpenAsks,
  goalPaused,
  goalProgress,
  GoalPersonChip,
  GoalStatusIcon,
  goalStatusIconState,
  ProjectPageHeader,
  useGoalClock,
  useGoalIssueText,
} from '@kortix/ui/workspace';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  pauseProjectGoal,
  replyToProjectGoal,
  restartProjectGoal,
  resumeProjectGoal,
  stopProjectGoal,
  type ProjectGoal,
  type ProjectGoalStatus,
} from '@kortix/sdk';
import { useProjectGoalFiles, useProjectGoals, useProjectSession } from '@kortix/sdk/react';
import { useMutation } from '@tanstack/react-query';
import {
  ArrowUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  ChatCircleIcon,
  ChatTextIcon,
  CircleDashedIcon,
  ClockCounterClockwiseIcon,
  ClockIcon,
  CheckCircleIcon,
  CircleIcon,
  DotsThreeIcon,
  FileIcon,
  FolderOpenIcon,
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
import { useState, type ReactNode } from 'react';

/**
 * /workspaces/[id]/goals/[scope]/[slug] — one goal's home, in two columns.
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
  const [sharing, setSharing] = useState(false);

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader
        title={goal?.goal?.objective ?? t('title')}
        breadcrumb={
          goal ? (
            <>
              <Link href={listHref} className="text-muted-foreground hover:text-foreground shrink-0 text-sm">
                {t('title')}
              </Link>
              <CaretRightIcon className="text-muted-foreground size-3 shrink-0" aria-hidden />
            </>
          ) : null
        }
      >
        {goal ? <GoalControls projectId={projectId} goal={goal} onChanged={refetch} onShare={() => setSharing(true)} /> : null}
      </ProjectPageHeader>
      <div className="@container/goal min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 pb-24 md:px-10">
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
              <Skeleton className="h-8 w-2/3 rounded-md" />
              <Skeleton className="h-4 w-1/2 rounded-md" />
              <Skeleton className="h-24 w-full rounded-md" />
            </div>
          ) : !goal ? (
            <EmptyState title={t('notFound')} />
          ) : (
            <div className="grid grid-cols-1 gap-12 @4xl/goal:grid-cols-[minmax(0,1fr)_15rem] @4xl/goal:gap-16">
              <GoalMain projectId={projectId} goal={goal} files={files.data ?? null} onChanged={refetch} />
              <GoalRail projectId={projectId} goal={goal} onShare={() => setSharing(true)} />
            </div>
          )}
        </div>
      </div>
      {goal ? <GoalShareModal projectId={projectId} goal={goal} open={sharing} onOpenChange={setSharing} /> : null}
    </div>
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

type GoalFilesData = { log: string | null; notes: string | null; verification: string | null };

/** The text `kortix goals new` and `createProjectGoal` seed under `## Context`: it says nothing until someone writes there. */
const CONTEXT_PLACEHOLDER = "The request in the person's words, constraints, and what was learned.";

/** GOAL.md's body as the goal's description: without its `# title` (the page shows it), the empty seed, or its `## Context` heading. */
function goalDescription(body: string | undefined): string {
  return (body ?? '')
    .replace(/^\s*# [^\n]*\n+/, '')
    .replace(CONTEXT_PLACEHOLDER, '')
    .trim()
    .replace(/^## Context\s*/, '')
    .trim();
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

function GoalMain({ projectId, goal, files, onChanged }: { projectId: string; goal: ProjectGoal; files: GoalFilesData | null; onChanged: () => Promise<unknown> }) {
  const t = useTranslations('goals');
  const issueText = useGoalIssueText();
  const doc = goal.goal;
  const paused = goalPaused(goal);
  const open = goal.health.state !== 'closed';
  const waiting = open && !paused && (doc?.status === 'waiting_on_user' || goalOpenAsks(doc).length > 0);
  const issues = open && !paused ? goal.health.issues : [];
  const description = goalDescription(doc?.body);
  const progress = goalProgress(doc);
  // Results: what the goal produced, minus the evidence files Done when already cites.
  const cited = new Set((doc?.success_criteria ?? []).map((c) => c.evidence).filter(Boolean));
  const results = (doc?.links ?? []).filter((link) => !cited.has(link));

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <header className="flex flex-col gap-5" data-testid="goal-overview">
        <h2 className="text-foreground text-2xl font-semibold tracking-tight text-balance">{doc?.objective ?? goal.slug}</h2>
        {description ? <GoalDescription markdown={description} /> : null}
      </header>

      {waiting ? <QuestionForYou projectId={projectId} goal={goal} onChanged={onChanged} /> : null}

      {issues.map((issue) => (
        <InfoBanner key={issue} tone="warning" icon={WarningIcon} title={t('attentionTitle')}>
          {issueText(issue, goal)}
        </InfoBanner>
      ))}

      <section className="flex flex-col gap-3" aria-label={t('doneWhen')} data-testid="goal-criteria">
        <SectionTitle aside={progress.total ? <span className="text-muted-foreground text-sm tabular-nums">{progress.met}/{progress.total}</span> : null}>
          {t('doneWhen')}
        </SectionTitle>
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
            <span className="text-foreground">{text(c.text)}</span>
            {text(c.evidence) ? <EvidenceFile path={text(c.evidence)!} folder={goal.folder} driveHref={driveHref} /> : null}
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
  // Only text from GOAL.md reaches the page (see `text`).
  const asks = goalOpenAsks(doc).filter((ask) => text(ask.title));
  const asked = doc?.status === 'waiting_on_user' ? text(doc.waiting_on) : null;
  const question = asked ?? asks[0]?.title ?? null;
  const otherAsks = asked ? asks : asks.slice(1);
  return (
    // A callout, not a section: the one place the page asks the person for something.
    <section
      className="bg-kortix-orange/15 flex flex-col gap-3 rounded-xl p-4"
      aria-label={t('questionForYou')}
      data-testid="goal-needs-you"
    >
      <div className="flex items-center gap-2">
        <GoalStatusIcon state="waiting" />
        <h2 className="text-foreground text-sm font-semibold">{t('questionForYou')}</h2>
      </div>
      {question ? (
        // Agent text: links in it stay clickable; untrusted, so no HTML.
        <div className="text-foreground max-w-prose">
          <UnifiedMarkdown content={question} trust="untrusted" variant="message" className="text-base" />
        </div>
      ) : null}
      {otherAsks.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {otherAsks.map((ask) => (
            <li key={ask.id} className="flex items-baseline justify-between gap-3">
              <span className="text-foreground min-w-0">{ask.title}</span>
              {text(ask.due) ? <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{t('due', { time: formatGoalTime(ask.due, locale, now) })}</span> : null}
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
 * wakes on it. The prompt-input shape: the text on top, a round send inside the
 * box at its bottom right. ⌘/Ctrl+Enter sends.
 */
function MessageBox({ projectId, goal, onChanged, kind }: { projectId: string; goal: ProjectGoal; onChanged: () => Promise<unknown>; kind: 'answer' | 'message' }) {
  const t = useTranslations('goals');
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState(false);
  const send = useMutation({
    mutationFn: () => replyToProjectGoal(projectId, goal, draft.trim()),
    onSuccess: () => {
      setDraft('');
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
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim() && !send.isPending) send.mutate();
      }}
    >
      <InputGroup className="bg-background items-stretch rounded-xl">
        <textarea
          rows={kind === 'answer' ? 3 : 2}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (sent) setSent(false);
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
            disabled={!draft.trim() || send.isPending}
            aria-busy={send.isPending}
            data-testid={kind === 'answer' ? 'goal-answer-send' : 'goal-message-send'}
          >
            <ArrowUpIcon weight="bold" className="size-3.5" aria-hidden />
            {t('send')}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}

type FeedItem = { key: string; at: string | null; order: number; icon: ReactNode; title: ReactNode; body?: ReactNode };

/**
 * What happened, oldest first, under a rule: every state move, a pause, the
 * independent check, and the agent's latest update. Each entry is one quiet line
 * (glyph, what happened, when); a reason sits under it. While the goal runs the
 * feed ends with the note box. The agent's log (log.md, notes.md) opens
 * from the heading's right.
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
  const hasLog = !!(files?.log || files?.notes);

  // The verifier's report folds under the move it decided: out of verifying, to done or back to active.
  const verdict = files?.verification ? transitions.findLastIndex((tr) => tr.from === 'verifying') : -1;
  const items: FeedItem[] = transitions.map((tr, index) => ({
    key: `t:${tr.at}:${index}`,
    at: tr.at,
    order: index,
    icon: tr.from === null ? <CheckCircleIcon weight="fill" className="text-kortix-green size-4" aria-hidden /> : <StatusGlyph status={tr.to} />,
    title:
      tr.from === null ? (
        t('feed.created')
      ) : (
        <>
          <span className="text-muted-foreground font-normal">{t('feed.movedPrefix')}</span> {t(`status.${tr.to}`)}
        </>
      ),
    body:
      index === verdict && files?.verification ? (
        <VerificationReport report={files.verification} />
      ) : text(tr.reason) && tr.to !== 'done' && tr.from !== null ? (
        text(tr.reason)!
      ) : undefined,
  }));
  if (doc?.summary) {
    items.push({ key: 'summary', at: updatedAt, order: transitions.length + 1, icon: <ChatTextIcon weight="fill" className="text-kortix-blue size-4" aria-hidden />, title: t('feed.update'), body: doc.summary });
  }
  if (paused && doc?.paused_at) {
    items.push({ key: 'paused', at: doc.paused_at, order: transitions.length + 2, icon: <GoalStatusIcon state="paused" />, title: t('feed.paused') });
  }
  items.sort((a, b) => a.order - b.order);

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
      {open && !paused && !waiting ? <MessageBox projectId={projectId} goal={goal} onChanged={onChanged} kind="message" /> : null}
    </section>
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

/**
 * The properties rail: one quiet row per property, its glyph and its value,
 * no labels (the glyph says what it is): state, agent, the next and last
 * check, wakes today, and who can see it (a ghost button to the share dialog). Then its sessions and
 * its folder. Sticky beside the main column; under it on a narrow container.
 */
function GoalRail({ projectId, goal, onShare }: { projectId: string; goal: ProjectGoal; onShare: () => void }) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const doc = goal.goal;
  const paused = goalPaused(goal);
  const open = goal.health.state !== 'closed';
  const heartbeat = goal.heartbeat;
  const today = new Date(now).toISOString().slice(0, 10);
  const scheduled = open && !paused && heartbeat?.state === 'active' && !!heartbeat.next_fire_at;
  const lastWake = goalLastWake(goal);
  const progress = goalProgress(doc);
  const driveHref = uiRoutes().drive(projectId);
  const folderHref = driveHref ? `${driveHref}?path=${encodeURIComponent(goal.folder)}` : null;
  const agent = text(doc?.agent);
  const { user } = useAuth();
  const stateLabel = !doc ? t('health.attention') : paused ? t('paused') : t(`status.${doc.status}`);

  return (
    <aside className="flex min-w-0 flex-col gap-7 self-start @4xl/goal:sticky @4xl/goal:top-10" aria-label={t('properties')} data-testid="goal-properties">
      <div className="flex flex-col gap-1">
        <SectionTitle>{t('properties')}</SectionTitle>
        <ul className="flex flex-col text-sm">
          <Property icon={<GoalStatusIcon state={goalIconState(goal)} progress={progress.total ? progress.met / progress.total : 0} />}>{stateLabel}</Property>
          <Property icon={agent ? <AgentMark slug={agent} size={14} tile={16} className="ring-0" /> : <RobotlessIcon />} muted={!agent}>
            {agent ?? t('noAgent')}
          </Property>
          <Property icon={<ClockIcon className="size-4" aria-hidden />} muted={!scheduled}>
            {scheduled ? t('nextCheckAt', { time: formatGoalTime(heartbeat!.next_fire_at, locale, now) }) : t('noCheck')}
          </Property>
          <Property icon={<ClockCounterClockwiseIcon className="size-4" aria-hidden />} muted={!lastWake}>
            {lastWake ? t('lastCheckAt', { time: formatGoalTime(lastWake, locale, now) }) : t('neverChecked')}
          </Property>
          {doc?.format === 'goal.md' ? (
            <Property icon={<LightningIcon className="size-4" aria-hidden />}>
              {t('wakesTodayCount', { count: doc.wake_day === today ? (doc.wake_count ?? 0) : 0, max: doc.max_wakes_per_day ?? 12 })}
            </Property>
          ) : null}
          {doc?.assigned_user && user && doc.assigned_user !== user.id ? (
            // Who it is for, only when that is someone else: "you" says nothing.
            <li className="flex h-8 min-w-0 items-center">
              <GoalPersonChip projectId={projectId} userId={doc.assigned_user} />
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

      {doc?.sessions?.length ? (
        <div className="flex flex-col gap-1">
          <SectionTitle
            aside={
              doc.format === 'goal.md' ? (
                <span className="text-muted-foreground text-sm tabular-nums">{t('ofMax', { count: doc.sessions.length, max: doc.max_sessions ?? 10 })}</span>
              ) : null
            }
          >
            {t('sessions')}
          </SectionTitle>
          <ul className="flex flex-col text-sm">
            {doc.sessions.filter((s) => text(s.id)).map((s) => (
              <li key={`${s.role}:${s.id}`}>
                <Link
                  href={uiRoutes().session(projectId, s.id)}
                  className="hover:bg-hover -mx-2 flex h-8 min-w-0 items-center gap-2 rounded-md px-2"
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
          <Link href={folderHref} className="hover:bg-hover text-foreground -mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-sm">
            <FolderOpenIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
            {t('openFolder')}
          </Link>
        </div>
      ) : null}
    </aside>
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
 * The goal's controls: Pause, Resume or Start goal again visible (the one
 * frequent control), the rest in one menu: the chat, sharing, and Stop.
 */
function GoalControls({ projectId, goal, onChanged, onShare }: { projectId: string; goal: ProjectGoal; onChanged: () => Promise<unknown>; onShare: () => void }) {
  const t = useTranslations('goals');
  const router = useRouter();
  const [stopping, setStopping] = useState(false);
  const open = goal.health.state !== 'closed';
  const writable = open && goal.goal?.format === 'goal.md';
  const paused = goalPaused(goal);
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
  // A stopped goal starts again in place: same folder, same owner session, same history.
  // An open goal nothing wakes (a start again whose wake failed) gets the same control: it only wakes the owner.
  const restartable =
    goal.goal?.format === 'goal.md' &&
    (goal.goal.status === 'stopped' || (writable && !paused && goal.health.issues.includes('no_heartbeat')));
  const restart = useMutation({
    mutationFn: () => restartProjectGoal(projectId, goal, t('restartReason')),
    onSuccess: async () => {
      await onChanged();
      successToast(t('restartedToast'));
    },
    // GOAL.md may already read open: the page shows what was written.
    onError: async () => {
      errorToast(t('restartError'));
      await onChanged();
    },
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
      {/* Pause or Resume and the ⋯ menu: one secondary button group. */}
      <ButtonGroup>
        {writable && !paused && !restartable ? (
          <Button size="xs" variant="secondary" className="gap-1.5" disabled={pause.isPending} aria-busy={pause.isPending} onClick={() => pause.mutate()} data-testid="goal-pause">
            <PauseIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />
            {t('pause')}
          </Button>
        ) : null}
        {restartable ? (
          <Button size="xs" variant="secondary" className="gap-1.5" disabled={restart.isPending} aria-busy={restart.isPending} onClick={() => restart.mutate()} data-testid="goal-restart">
            <PlayIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />
            {t('restart')}
          </Button>
        ) : null}
        {writable && paused ? (
          <Button size="xs" variant="secondary" className="gap-1.5" disabled={resume.isPending} aria-busy={resume.isPending} onClick={() => resume.mutate()} data-testid="goal-resume">
            <PlayIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />
            {t('resume')}
          </Button>
        ) : null}
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
      </ButtonGroup>
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
    </>
  );
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

/** A URL as its last path segment (or its host) and its host; the full URL stays in the link's title. */
function urlLabel(link: string): { name: string; host: string } {
  try {
    const url = new URL(link);
    const segments = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
    const last = segments.at(-1);
    // A bare number or id ("1") says nothing alone: then the name is the host and the path stays beside it.
    if (last && /\p{L}/u.test(last)) return { name: last, host: url.host };
    return { name: url.host, host: segments.length ? `/${segments.join('/')}` : '' };
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
    const label = urlLabel(link);
    return (
      <a href={link} target="_blank" rel="noreferrer" title={link} className="flex min-w-0 items-center gap-2 underline-offset-2 hover:underline">
        {/* The site's favicon says where it goes (GitHub, Linear, Notion, …): the name alone follows. */}
        <FaviconAvatar value={link} size="2xs" className="shrink-0" />
        <span className="text-foreground min-w-0 truncate">{label.name}</span>
        {label.host.startsWith('/') ? <span className="text-muted-foreground min-w-0 truncate text-xs">{label.host}</span> : null}
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
      <span title={link} className={inFiles ? 'text-foreground min-w-0 truncate' : 'text-muted-foreground min-w-0 truncate'}>
        {name}
      </span>
      <span className="text-muted-foreground min-w-0 truncate text-xs">{link.startsWith('/') ? parent : link.split('/').slice(0, -1).join('/')}</span>
      {inFiles ? <OpenFolderAction href={`${driveHref}?path=${encodeURIComponent(parent)}`} file={name} /> : null}
    </span>
  );
}
