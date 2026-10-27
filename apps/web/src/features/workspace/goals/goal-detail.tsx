'use client';

import { Button } from '@kortix/ui/button';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { Skeleton } from '@kortix/ui/skeleton';
import { uiRoutes } from '@kortix/ui';
import {
  formatGoalTime,
  GoalHealthDot,
  goalOpenAsks,
  goalProgress,
  GoalStatusBadge,
  ProjectPageHeader,
  useGoalClock,
  useGoalIssueText,
} from '@kortix/ui/workspace';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { ProjectGoal } from '@kortix/sdk';
import { useProjectGoalFiles, useProjectGoals, useProjectSession } from '@kortix/sdk/react';
import { ArrowLeftIcon, CheckCircleIcon, CircleIcon, FolderOpenIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * /projects/[id]/goals/[scope]/[slug] — one goal: what it is for, whether it
 * is still running (health, heartbeat), what it waits on, its criteria with
 * evidence, items, sessions, the status timeline, and the folder's
 * verification, notes and log. Everything is read from the goal folder in
 * Files and the heartbeat reminder; nothing here edits the goal.
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
  const driveHref = uiRoutes().drive(projectId);
  const fileHref = (relative: string) =>
    driveHref ? `${driveHref}?path=${encodeURIComponent(`${goal.folder}/${relative.split('/').slice(0, -1).join('/')}`.replace(/\/$/, ''))}` : null;
  const heartbeat = goal.heartbeat;

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <GoalStatusBadge status={doc?.status} />
          <span className="text-muted-foreground text-xs">{t(`scope.${goal.scope}`)}</span>
          <span className="text-muted-foreground text-xs tabular-nums">{t('criteria', { met: progress.met, total: progress.total })}</span>
        </div>
        {doc?.summary ? <p className="text-foreground text-sm">{doc.summary}</p> : null}
      </div>

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
            <dd className="text-foreground">{formatGoalTime(heartbeat?.last_fired_at, locale, now)}</dd>
          </dl>
        </div>
      </Section>

      {asks.length > 0 ? (
        <Section title={t('needsYou')}>
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
          <UnifiedMarkdown content={files.verification} trust="untrusted" variant="document" />
        </Section>
      ) : null}
      {files?.notes ? (
        <Section title={t('notes')}>
          <UnifiedMarkdown content={files.notes} trust="untrusted" variant="document" />
        </Section>
      ) : null}
      {files?.log ? (
        <Section title={t('log')}>
          <UnifiedMarkdown content={files.log} trust="untrusted" variant="document" />
        </Section>
      ) : null}
    </>
  );
}

/** A session's display name, or its id until the row loads (or when it is gone). */
function SessionName({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useProjectSession(projectId, sessionId);
  return <>{session.data?.name || sessionId}</>;
}
