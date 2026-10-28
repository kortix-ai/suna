'use client';

import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast, successToast } from '@kortix/ui/toast';
import { uiRoutes } from '@kortix/ui';
import {
  formatGoalTime,
  goalLastWake,
  GoalHealthDot,
  goalOpenAsks,
  goalProgress,
  GoalStatusBadge,
  ProjectPageHeader,
  useGoalClock,
  useGoalIssueText,
  useGoalPerson,
} from '@kortix/ui/workspace';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { stopProjectGoal, type ProjectGoal } from '@kortix/sdk';
import { useProjectGoalFiles, useProjectGoals, useProjectSession } from '@kortix/sdk/react';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeftIcon, CheckCircleIcon, CircleIcon, FolderOpenIcon, ShareNetworkIcon } from '@phosphor-icons/react';
import { FolderAccessPanel } from '@/features/drives/folder-access-panel';
import { Popover, PopoverContent, PopoverTrigger } from '@kortix/ui/popover';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

/**
 * /projects/[id]/goals/[scope]/[slug] — one goal: what it is for, who it is
 * for and who works it, whether it is still running (health, heartbeat,
 * wakes), what it waits on, its done criteria with evidence, links, sessions,
 * the state timeline, and the folder's verification, context and log.
 * Everything is read from the goal folder in Files and the heartbeat loop.
 * A person answers the goal's question (`replyToProjectGoal`, which wakes the
 * owner) or stops it (`stopProjectGoal`). Share = the folder's Files sharing.
 */
export function GoalDetail({ projectId, scope, slug }: { projectId: string; scope: string; slug: string }) {
  const t = useTranslations('goals');
  const goals = useProjectGoals(projectId);
  const goal = goals.data?.find((g) => g.scope === scope && g.slug === slug) ?? null;
  const files = useProjectGoalFiles(projectId, goal);
  const listHref = uiRoutes().goals(projectId) ?? '#';
  const driveHref = uiRoutes().drive(projectId);
  const folderHref = goal && driveHref ? `${driveHref}?path=${encodeURIComponent(goal.folder)}` : null;
  const sessionHref = goal?.coordinatorSessionId ? uiRoutes().session(projectId, goal.coordinatorSessionId) : null;

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={goal?.goal?.objective ?? t('title')}>
        {folderHref ? (
          <Button asChild size="sm" variant="ghost" className="gap-1.5">
            <Link href={folderHref}>
              <FolderOpenIcon className="size-3.5" aria-hidden />
              {t('openFolder')}
            </Link>
          </Button>
        ) : null}
        {goal && folderHref ? <ShareGoalButton goal={goal} folderHref={folderHref} /> : null}
        {goal && goal.health.state !== 'closed' && goal.goal?.format === 'goal.md' ? (
          <StopGoalButton projectId={projectId} goal={goal} onStopped={() => goals.refetch()} />
        ) : null}
        {sessionHref ? (
          <Button asChild size="sm" variant="secondary">
            <Link href={sessionHref}>{t('openSession')}</Link>
          </Button>
        ) : null}
      </ProjectPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-8 px-4 py-6 pb-20 md:px-8">
          <Link href={listHref} className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs">
            <ArrowLeftIcon className="size-3" aria-hidden />
            {t('back')}
          </Link>
          {goals.isError ? (
            <ErrorState
              title={t('loadError')}
              action={
                <Button size="sm" variant="outline" onClick={() => goals.refetch()}>
                  {t('retry')}
                </Button>
              }
            />
          ) : goals.isLoading ? (
            <Skeleton className="h-40 w-full rounded-md" />
          ) : !goal ? (
            <EmptyState title={t('notFound')} />
          ) : (
            <GoalBody projectId={projectId} goal={goal} files={files.data ?? null} />
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-foreground text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

function GoalBody({
  projectId,
  goal,
  files,
}: {
  projectId: string;
  goal: ProjectGoal;
  files: { log: string | null; notes: string | null; verification: string | null } | null;
}) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const issueText = useGoalIssueText();
  const doc = goal.goal;
  const progress = goalProgress(doc);
  const asks = goalOpenAsks(doc);
  const personOf = useGoalPerson(projectId);
  const driveHref = uiRoutes().drive(projectId);
  const fileHref = (relative: string) =>
    driveHref ? `${driveHref}?path=${encodeURIComponent(`${goal.folder}/${relative.split('/').slice(0, -1).join('/')}`.replace(/\/$/, ''))}` : null;
  const heartbeat = goal.heartbeat;

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <GoalStatusBadge status={doc?.status} />
          {goal.scope === 'personal' ? <span className="text-muted-foreground text-xs">{t('scope.personal')}</span> : null}
          <span className="text-muted-foreground text-xs tabular-nums">{t('criteria', { met: progress.met, total: progress.total })}</span>
        </div>
        {doc?.summary ? <p className="text-foreground text-sm">{doc.summary}</p> : null}
        <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt>{t('assignedUser')}</dt>
          <dd className="text-foreground">
            {personOf(doc?.assigned_user) ?? '—'}
          </dd>
          <dt>{t('assignedAgent')}</dt>
          <dd className="text-foreground">{doc?.agent ?? '—'}</dd>
        </dl>
      </div>

      {doc?.status === 'waiting_on_user' || asks.length > 0 ? (
        <Section title={t('needsYou')}>
          {asks.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm">
              {asks.map((ask) => (
                <li key={ask.id} className="flex items-baseline justify-between gap-3">
                  <span className="text-foreground min-w-0">{ask.title}</span>
                  {ask.due ? (
                    <span className="text-muted-foreground shrink-0 text-xs">{t('due', { time: formatGoalTime(ask.due, locale, now) })}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {doc?.status === 'waiting_on_user' ? <WaitingOn projectId={projectId} goal={goal} question={doc.waiting_on ?? null} /> : null}
        </Section>
      ) : null}

      <Section title={t('successCriteria')}>
        {doc?.success_criteria?.length ? (
          <ul className="flex flex-col gap-2 text-sm">
            {doc.success_criteria.map((c) => {
              const href = c.evidence ? fileHref(c.evidence) : null;
              return (
                <li key={c.id} className="flex items-start gap-2">
                  {c.met ? (
                    <CheckCircleIcon className="text-kortix-green mt-0.5 size-4 shrink-0" aria-label={t('met')} />
                  ) : (
                    <CircleIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-label={t('notMet')} />
                  )}
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-foreground">{c.text}</span>
                    {c.evidence ? (
                      href ? (
                        <Link href={href} className="text-muted-foreground hover:text-foreground w-fit truncate text-xs underline-offset-2 hover:underline">
                          {c.evidence}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground text-xs">{c.evidence}</span>
                      )
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">{t('noCriteria')}</p>
        )}
      </Section>

      {doc?.links?.length ? (
        <Section title={t('links')}>
          <ul className="flex flex-col gap-1 text-sm">
            {doc.links.map((link) => (
              <li key={link} className="min-w-0 truncate">
                <LinkTarget link={link} folder={goal.folder} driveHref={driveHref} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={t('healthTitle')}>
        <div className="flex flex-col gap-2 text-sm" data-testid="goal-health">
          <div className="flex items-center gap-2">
            <GoalHealthDot goal={goal} />
            <span className="text-foreground">{t(`health.${goal.health.state}`)}</span>
          </div>
          {goal.health.issues.map((issue) => (
            <p key={issue} className="text-muted-foreground pl-4 text-xs">
              {issueText(issue, goal)}
            </p>
          ))}
          <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pl-4 text-xs">
            <dt>{t('heartbeat')}</dt>
            <dd className="text-foreground">
              {heartbeat?.state === 'active' && heartbeat.next_fire_at
                ? t('nextWake', { time: formatGoalTime(heartbeat.next_fire_at, locale, now) })
                : heartbeat?.state === 'paused'
                  ? t('heartbeatPaused')
                  : t('noWake')}
            </dd>
            <dt>{t('lastWakeLabel')}</dt>
            <dd className="text-foreground">{formatGoalTime(goalLastWake(goal), locale, now)}</dd>
            {doc?.format === 'goal.md' ? (
              <>
                <dt>{t('wakesToday')}</dt>
                <dd className="text-foreground tabular-nums">
                  {t('ofMax', {
                    count: doc.wake_day === new Date(now).toISOString().slice(0, 10) ? (doc.wake_count ?? 0) : 0,
                    max: doc.max_wakes_per_day ?? 12,
                  })}
                </dd>
                <dt>{t('sessions')}</dt>
                <dd className="text-foreground tabular-nums">
                  {t('ofMax', { count: doc.sessions.length, max: doc.max_sessions ?? 10 })}
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      </Section>

      {doc?.format === 'goal.json' ? (
      <Section title={t('items')}>
        {doc?.items?.length ? (
          <ul className="flex flex-col divide-y text-sm">
            {doc.items.map((item) => (
              <li key={item.id} className="flex items-baseline gap-3 py-2">
                <span className="text-muted-foreground w-12 shrink-0 text-xs">{t(`kind.${item.kind}`)}</span>
                <span className={item.status === 'done' || item.status === 'dropped' ? 'text-muted-foreground min-w-0 flex-1 line-through' : 'text-foreground min-w-0 flex-1'}>
                  {item.title}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {[item.owner, item.due ? formatGoalTime(item.due, locale, now) : null, t(`itemStatus.${item.status}`)].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">{t('noItems')}</p>
        )}
      </Section>
      ) : null}

      {doc?.sessions?.length ? (
        <Section title={t('sessions')}>
          <ul className="flex flex-col gap-1 text-sm">
            {doc.sessions.map((s) => {
              const href = uiRoutes().session(projectId, s.id);
              return (
                <li key={`${s.role}:${s.id}`} className="flex items-baseline gap-3">
                  <span className="text-muted-foreground w-28 shrink-0 text-xs">{t(`role.${s.role}`)}</span>
                  <Link href={href} className="text-foreground min-w-0 truncate hover:underline">
                    <SessionName projectId={projectId} sessionId={s.id} />
                  </Link>
                  <span className="text-muted-foreground shrink-0 text-xs">{formatGoalTime(s.since, locale, now)}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      {doc?.transitions?.length ? (
        <Section title={t('timeline')}>
          <ol className="flex flex-col gap-2 text-sm">
            {[...doc.transitions].reverse().map((tr, index) => (
              <li key={`${tr.at}:${index}`} className="flex items-baseline gap-3">
                <span className="text-muted-foreground w-28 shrink-0 text-xs">{formatGoalTime(tr.at, locale, now)}</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-foreground">
                    {tr.from ? `${t(`status.${tr.from}`)} → ` : ''}
                    {t(`status.${tr.to}`)}
                  </span>
                  <span className="text-muted-foreground text-xs">{tr.reason}</span>
                </span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {files?.verification ? (
        <Section title={t('verification')}>
          <UnifiedMarkdown content={withoutTitle(files.verification)} trust="untrusted" variant="document" />
        </Section>
      ) : null}
      {doc?.body?.trim() ? (
        <Section title={t('context')}>
          <UnifiedMarkdown content={doc.body} trust="untrusted" variant="document" />
        </Section>
      ) : null}
      {files?.notes ? (
        <Section title={t('notes')}>
          <UnifiedMarkdown content={withoutTitle(files.notes)} trust="untrusted" variant="document" />
        </Section>
      ) : null}
      {files?.log ? (
        <Section title={t('log')}>
          <UnifiedMarkdown content={withoutTitle(files.log)} trust="untrusted" variant="document" />
        </Section>
      ) : null}
    </>
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

/** A `links:` entry: a URL opens as is, a path opens its folder in Files (relative paths are inside the goal folder). */
function LinkTarget({ link, folder, driveHref }: { link: string; folder: string; driveHref: string | null }) {
  const className = 'text-foreground underline-offset-2 hover:underline';
  if (/^https?:\/\//.test(link)) {
    return (
      <a href={link} target="_blank" rel="noreferrer" className={className}>
        {link}
      </a>
    );
  }
  const path = link.startsWith('/') ? link : `${folder}/${link}`;
  const parent = path.split('/').slice(0, -1).join('/') || '/';
  return driveHref ? (
    <Link href={`${driveHref}?path=${encodeURIComponent(parent)}`} className={className}>
      {link}
    </Link>
  ) : (
    <span className="text-foreground">{link}</span>
  );
}

/** What the goal waits on, and the way to answer: in the chat of the session that asked. */
function WaitingOn({ projectId, goal, question }: { projectId: string; goal: ProjectGoal; question: string | null }) {
  const t = useTranslations('goals');
  const href = goal.coordinatorSessionId ? uiRoutes().session(projectId, goal.coordinatorSessionId) : null;
  return (
    <div className="flex flex-col items-start gap-3">
      {question ? <p className="text-foreground text-sm">{question}</p> : null}
      {href ? (
        <Button asChild size="sm" variant="secondary">
          <Link href={href}>{t('answerInChat')}</Link>
        </Button>
      ) : null}
    </div>
  );
}

/** Any state → stopped, by a person: GOAL.md and log.md record it, and the heartbeat goes. */
function StopGoalButton({ projectId, goal, onStopped }: { projectId: string; goal: ProjectGoal; onStopped: () => void }) {
  const t = useTranslations('goals');
  const [open, setOpen] = useState(false);
  const stop = useMutation({
    mutationFn: () => stopProjectGoal(projectId, goal, t('stopReason')),
    onSuccess: () => {
      setOpen(false);
      successToast(t('stoppedToast'));
      onStopped();
    },
    onError: () => errorToast(t('stopError')),
  });
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t('stop')}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
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

/** Share = the goal folder's Files sharing: who can open it now, and the way to change it. */
function ShareGoalButton({ goal, folderHref }: { goal: ProjectGoal; folderHref: string }) {
  const t = useTranslations('goals');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="gap-1.5">
          <ShareNetworkIcon className="size-3.5" aria-hidden />
          {t('share')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-88 p-4">
        <FolderAccessPanel
          driveId={goal.driveId}
          path={goal.folder}
          onManage={() => {
            setOpen(false);
            router.push(folderHref);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
