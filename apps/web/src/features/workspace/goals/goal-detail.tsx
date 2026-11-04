'use client';

import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@kortix/ui/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { Hint } from '@kortix/ui/hint';
import { InfoBanner } from '@kortix/ui/info-banner';
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
  GoalStatusBadge,
  ProjectPageHeader,
  useGoalClock,
  useGoalIssueText,
  useGoalPerson,
  useGoalStateText,
} from '@kortix/ui/workspace';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { pauseProjectGoal, replyToProjectGoal, resumeProjectGoal, stopProjectGoal, type ProjectGoal } from '@kortix/sdk';
import { useProjectGoalFiles, useProjectGoals, useProjectSession } from '@kortix/sdk/react';
import { useMutation } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  CaretRightIcon,
  ChatCircleIcon,
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
 * /projects/[id]/goals/[scope]/[slug] — one goal's home. It answers, in this
 * order: where the goal stands and what happens next, what it needs from the
 * viewer (answered here, `replyToProjectGoal`), its done criteria with
 * evidence, what it produced, and what happened. Sessions, the heartbeat,
 * limits and the raw files sit under Details. A person pauses or resumes it
 * (`pauseProjectGoal`, `resumeProjectGoal`) or stops it (`stopProjectGoal`).
 * Everything is read from the goal folder in Files and its heartbeat loop.
 */
export function GoalDetail({ projectId, scope, slug }: { projectId: string; scope: string; slug: string }) {
  const t = useTranslations('goals');
  const goals = useProjectGoals(projectId);
  const goal = goals.data?.find((g) => g.scope === scope && g.slug === slug) ?? null;
  const files = useProjectGoalFiles(projectId, goal);
  const listHref = uiRoutes().goals(projectId) ?? '#';

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={goal?.goal?.objective ?? t('title')}>
        {goal ? <GoalControls projectId={projectId} goal={goal} onChanged={() => goals.refetch()} /> : null}
      </ProjectPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-8 px-4 py-6 pb-20 md:px-8">
          <Link href={listHref} className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs">
            <ArrowLeftIcon className="size-3" aria-hidden />
            {t('back')}
          </Link>
          {goals.isError ? (
            <ErrorState
              size="sm"
              title={t('loadError')}
              action={
                <Button size="sm" variant="outline" onClick={() => goals.refetch()}>
                  {t('retry')}
                </Button>
              }
            />
          ) : goals.isLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-5 w-2/3 rounded-md" />
              <Skeleton className="h-24 w-full rounded-md" />
            </div>
          ) : !goal ? (
            <EmptyState title={t('notFound')} />
          ) : (
            <GoalBody projectId={projectId} goal={goal} files={files.data ?? null} onChanged={() => goals.refetch()} />
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title} data-testid={testId}>
      <h2 className="text-muted-foreground text-xs font-medium">{title}</h2>
      {children}
    </section>
  );
}

/** Characters past which the lead sentence (usually an agent's question) drops to body size. */
const LONG_LEAD = 160;

type GoalFilesData = { log: string | null; notes: string | null; verification: string | null };

function GoalBody({
  projectId,
  goal,
  files,
  onChanged,
}: {
  projectId: string;
  goal: ProjectGoal;
  files: GoalFilesData | null;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const stateText = useGoalStateText();
  const issueText = useGoalIssueText();
  const doc = goal.goal;
  const paused = goalPaused(goal);
  const open = goal.health.state !== 'closed';
  const asks = goalOpenAsks(doc);
  const waiting = open && !paused && (doc?.status === 'waiting_on_user' || asks.length > 0);
  const issues = open && !paused ? goal.health.issues : [];
  const updatedAt = goalLastWake(goal) ?? doc?.transitions?.at(-1)?.at ?? null;
  const leadText = stateText(goal, locale, now);
  // Results: what the goal produced, minus the evidence files Done when already cites.
  const cited = new Set((doc?.success_criteria ?? []).map((c) => c.evidence).filter(Boolean));
  const results = (doc?.links ?? []).filter((link) => !cited.has(link));

  return (
    <>
      <div className="flex flex-col gap-3" data-testid="goal-overview">
        <div className="flex flex-wrap items-center gap-3">
          <GoalStatusBadge status={doc?.status} paused={paused} />
          <GoalCriteriaProgress goal={doc} />
        </div>
        <p
          className={
            // A short state reads as the page's lead; an agent's long question reads as body text.
            leadText.length > LONG_LEAD ? 'text-foreground text-sm whitespace-pre-line text-pretty' : 'text-foreground text-base text-pretty'
          }
          data-testid="goal-state"
        >
          {leadText}
        </p>
        {waiting ? <NeedsYou projectId={projectId} goal={goal} onChanged={onChanged} /> : null}
        {doc?.summary ? (
          <p className="text-muted-foreground text-sm text-pretty">
            {doc.summary}
            {updatedAt ? <span className="whitespace-nowrap tabular-nums"> · {t('updated', { time: formatGoalTime(updatedAt, locale, now) })}</span> : null}
          </p>
        ) : null}
      </div>

      {issues.map((issue) => (
        <InfoBanner key={issue} tone="warning" icon={WarningIcon} title={t('attentionTitle')}>
          {issueText(issue, goal)}
        </InfoBanner>
      ))}

      <Section title={t('doneWhen')} testId="goal-criteria">
        {doc?.success_criteria?.length ? <CriteriaList projectId={projectId} goal={goal} /> : <p className="text-muted-foreground text-sm">{t('noCriteria')}</p>}
      </Section>

      {results.length ? (
        <Section title={t('results')}>
          <ul className="flex flex-col gap-1.5 text-sm">
            {results.map((link) => (
              <li key={link} className="min-w-0">
                <LinkTarget link={link} folder={goal.folder} driveHref={uiRoutes().drive(projectId)} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {files?.verification ? <Verification report={files.verification} done={doc?.status === 'done'} /> : null}

      {doc?.transitions?.length ? (
        <Section title={t('activity')}>
          <ol className="flex flex-col gap-3 text-sm">
            {paused && doc.paused_at ? (
              <li className="flex items-baseline gap-3">
                <span className="text-muted-foreground w-24 shrink-0 text-xs tabular-nums">{formatGoalTime(doc.paused_at, locale, now)}</span>
                <span className="text-foreground">{t('paused')}</span>
              </li>
            ) : null}
            {[...doc.transitions].reverse().map((tr, index) => (
              <li key={`${tr.at}:${index}`} className="flex items-baseline gap-3">
                <span className="text-muted-foreground w-24 shrink-0 text-xs tabular-nums">{formatGoalTime(tr.at, locale, now)}</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-foreground">{t(`status.${tr.to}`)}</span>
                  {/* The verifier's own words live in the report above: the Done row needs no copy of them. */}
                  {tr.reason && tr.to !== 'done' ? <span className="text-muted-foreground line-clamp-2 text-xs">{tr.reason}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <GoalDetails projectId={projectId} goal={goal} files={files} />
    </>
  );
}

/** Done criteria, met first-class: a green check with its evidence, or an empty circle. */
function CriteriaList({ projectId, goal }: { projectId: string; goal: ProjectGoal }) {
  const t = useTranslations('goals');
  const driveHref = uiRoutes().drive(projectId);
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {(goal.goal?.success_criteria ?? []).map((c) => {
        return (
          <li key={c.id} className="flex items-start gap-2">
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
        );
      })}
    </ul>
  );
}

/** What the goal waits on, and the answer box: the answer goes to the owner session, which wakes on it. */
function NeedsYou({ projectId, goal, onChanged }: { projectId: string; goal: ProjectGoal; onChanged: () => Promise<unknown> }) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const doc = goal.goal;
  const asks = goalOpenAsks(doc);
  // The page's lead sentence is the question; list only the other open asks here.
  const question = doc?.status === 'waiting_on_user' ? (doc.waiting_on ?? null) : null;
  const otherAsks = question ? asks : asks.slice(1);
  const [answer, setAnswer] = useState('');
  const [sent, setSent] = useState(false);
  const chatHref = goal.coordinatorSessionId ? uiRoutes().session(projectId, goal.coordinatorSessionId) : null;
  const reply = useMutation({
    mutationFn: () => replyToProjectGoal(projectId, goal, answer.trim()),
    onSuccess: () => {
      setAnswer('');
      setSent(true);
      successToast(t('answerSentToast'));
      void onChanged();
    },
    onError: () => errorToast(t('answerError')),
  });
  return (
    <div className="flex flex-col gap-3" data-testid="goal-needs-you">
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
        {goal.coordinatorSessionId ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (answer.trim() && !reply.isPending) reply.mutate();
            }}
          >
            <Textarea
              rows={3}
              value={answer}
              onChange={(event) => {
                setAnswer(event.target.value);
                if (sent) setSent(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
              }}
              placeholder={t('answerPlaceholder')}
              aria-label={t('answerLabel')}
              data-testid="goal-answer"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              {sent ? (
                <p className="text-muted-foreground text-xs" role="status">
                  {t('answerSent')}
                </p>
              ) : chatHref ? (
                <Link href={chatHref} className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline">
                  {t('answerInChat')}
                </Link>
              ) : (
                <span />
              )}
              <Button type="submit" size="sm" disabled={!answer.trim() || reply.isPending} aria-busy={reply.isPending} data-testid="goal-answer-send">
                {t('sendAnswer')}
              </Button>
            </div>
          </form>
        ) : null}
    </div>
  );
}

/** The verifier's verdict in one line; its full report folds behind "Show report". */
function Verification({ report, done }: { report: string; done: boolean }) {
  const t = useTranslations('goals');
  const [open, setOpen] = useState(false);
  return (
    <Section title={t('verification')} testId="goal-verification">
      <p className="text-foreground flex items-center gap-2 text-sm">
        {done ? <CheckCircleIcon weight="fill" className="text-kortix-green size-4 shrink-0" aria-hidden /> : null}
        {done ? t('verifiedPass') : t('verifiedReport')}
      </p>
      <Disclosure open={open} onOpenChange={setOpen}>
        <DisclosureTrigger>
          <button type="button" className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs">
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
    </Section>
  );
}

/** An evidence file: its name, and a way to its folder in Files that says it opens the folder. */
function EvidenceFile({ path, folder, driveHref }: { path: string; folder: string; driveHref: string | null }) {
  const t = useTranslations('goals');
  const parent = `${folder}/${path}`.split('/').slice(0, -1).join('/');
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
      <span className="min-w-0 truncate">{path}</span>
      {driveHref ? (
        <Hint label={t('openInFiles')}>
          <Link href={`${driveHref}?path=${encodeURIComponent(parent)}`} className="hover:text-foreground shrink-0" aria-label={t('openFolderOf', { file: path })}>
            <FolderOpenIcon className="size-3.5" aria-hidden />
          </Link>
        </Hint>
      ) : null}
    </span>
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
 * the rest in one menu: the chat, the folder, sharing, and Stop.
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
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={pause.isPending}
          aria-busy={pause.isPending}
          onClick={() => pause.mutate()}
          data-testid="goal-pause"
        >
          <PauseIcon className="size-3.5 shrink-0" aria-hidden />
          {t('pause')}
        </Button>
      ) : null}
      {writable && paused ? (
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={resume.isPending}
          aria-busy={resume.isPending}
          onClick={() => resume.mutate()}
          data-testid="goal-resume"
        >
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
          {folderHref ? (
            <DropdownMenuItem onSelect={() => router.push(folderHref)}>
              <FolderOpenIcon aria-hidden />
              {t('openFolder')}
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

/** Who it is for, how it runs, its sessions and its raw files: what a person opens when something looks wrong. */
function GoalDetails({ projectId, goal, files }: { projectId: string; goal: ProjectGoal; files: GoalFilesData | null }) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const personOf = useGoalPerson(projectId);
  const doc = goal.goal;
  const heartbeat = goal.heartbeat;
  const [open, setOpen] = useState(false);
  const row = (label: string, value: ReactNode) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground min-w-0">{value}</dd>
    </>
  );
  return (
    <Disclosure open={open} onOpenChange={setOpen} className="border-border border-t pt-4">
      <DisclosureTrigger>
        <button type="button" className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm font-medium" data-testid="goal-details-toggle">
          <CaretRightIcon className="size-3.5 transition-transform data-[open=true]:rotate-90" data-open={open} aria-hidden />
          {t('details')}
        </button>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="flex flex-col gap-8 pt-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-xs">
            {row(t('assignedUser'), personOf(doc?.assigned_user) ?? '—')}
            {row(t('assignedAgent'), doc?.agent ?? '—')}
            {row(t('scopeLabel'), t(`scope.${goal.scope}`))}
            {row(
              t('heartbeat'),
              doc?.paused_at
                ? t('heartbeatPaused')
                : heartbeat?.state === 'active' && heartbeat.next_fire_at
                  ? t('nextWake', { time: formatGoalTime(heartbeat.next_fire_at, locale, now) })
                  : heartbeat?.state === 'paused'
                    ? t('heartbeatPaused')
                    : t('noWake'),
            )}
            {row(t('lastWakeLabel'), formatGoalTime(goalLastWake(goal), locale, now))}
            {doc?.format === 'goal.md' ? (
              <>
                {row(
                  t('wakesToday'),
                  <span className="tabular-nums">
                    {t('ofMax', {
                      count: doc.wake_day === new Date(now).toISOString().slice(0, 10) ? (doc.wake_count ?? 0) : 0,
                      max: doc.max_wakes_per_day ?? 12,
                    })}
                  </span>,
                )}
                {row(t('sessions'), <span className="tabular-nums">{t('ofMax', { count: doc.sessions.length, max: doc.max_sessions ?? 10 })}</span>)}
              </>
            ) : null}
            {row(t('folder'), <span className="font-mono break-all">{goal.folder}</span>)}
          </dl>

          {doc?.sessions?.length ? (
            <Section title={t('sessions')}>
              <ul className="flex flex-col gap-1 text-sm">
                {doc.sessions.map((s) => (
                  <li key={`${s.role}:${s.id}`} className="flex items-baseline gap-3">
                    <span className="text-muted-foreground w-24 shrink-0 text-xs">{t(`role.${s.role}`)}</span>
                    <Link href={uiRoutes().session(projectId, s.id)} className="text-foreground min-w-0 truncate hover:underline">
                      <SessionName projectId={projectId} sessionId={s.id} />
                    </Link>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatGoalTime(s.since, locale, now)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {doc?.format === 'goal.json' && doc.items?.length ? (
            <Section title={t('items')}>
              <ul className="divide-border flex flex-col divide-y text-sm">
                {doc.items.map((item) => (
                  <li key={item.id} className="flex items-baseline gap-3 py-2">
                    <span className="text-muted-foreground w-12 shrink-0 text-xs">{t(`kind.${item.kind}`)}</span>
                    <span className={item.status === 'done' || item.status === 'dropped' ? 'text-muted-foreground min-w-0 flex-1 line-through' : 'text-foreground min-w-0 flex-1'}>
                      {item.title}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">{t(`itemStatus.${item.status}`)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {doc?.body?.trim() ? (
            <Section title={t('context')}>
              <UnifiedMarkdown content={doc.body} trust="untrusted" variant="document" className="text-sm" />
            </Section>
          ) : null}
          {files?.notes ? (
            <Section title={t('notes')}>
              <UnifiedMarkdown content={withoutTitle(files.notes)} trust="untrusted" variant="document" className="text-sm" />
            </Section>
          ) : null}
          {files?.log ? (
            <Section title={t('log')}>
              <UnifiedMarkdown content={withoutTitle(files.log)} trust="untrusted" variant="document" className="text-sm" />
            </Section>
          ) : null}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}

/** A goal file under its own section heading: drop the file's leading `# Title`, the section already names it. */
function withoutTitle(markdown: string): string {
  return markdown.replace(/^\s*# [^\n]*\n+/, '');
}

/** A session's display name, or its id until the row loads (or when it is gone). */
function SessionName({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useProjectSession(projectId, sessionId);
  return <>{session.data?.name || sessionId}</>;
}

/**
 * A `links:` entry: a URL opens as is. A path in Files shows its name and its
 * folder, plus a folder action that opens that folder in Files (the same row
 * as an evidence file). A path inside a session's sandbox (`/workspace`,
 * `/drives`) is not in Files: it shows muted, with no action.
 */
function LinkTarget({ link, folder, driveHref }: { link: string; folder: string; driveHref: string | null }) {
  const t = useTranslations('goals');
  if (/^https?:\/\//.test(link)) {
    return (
      <a href={link} target="_blank" rel="noreferrer" className="text-foreground flex min-w-0 items-center gap-2 underline-offset-2 hover:underline">
        <LinkIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{link}</span>
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
      {inFiles ? (
        <Hint label={t('openInFiles')}>
          <Link
            href={`${driveHref}?path=${encodeURIComponent(parent)}`}
            className="text-muted-foreground hover:text-foreground shrink-0"
            aria-label={t('openFolderOf', { file: name })}
          >
            <FolderOpenIcon className="size-3.5" aria-hidden />
          </Link>
        </Hint>
      ) : null}
    </span>
  );
}
