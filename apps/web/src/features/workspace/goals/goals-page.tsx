'use client';

import { Button } from '@kortix/ui/button';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { Skeleton } from '@kortix/ui/skeleton';
import {
  formatGoalTime,
  GoalHealthDot,
  goalHref,
  goalNeedsYou,
  goalOpenAsks,
  goalProgress,
  GoalStatusBadge,
  ALL_DOMAINS,
  ProjectPageHeader,
  SpaceFilterTabs,
  spaceFilterLabel,
  useGoalClock,
  useGoalIssueText,
  useSpaceFilter,
} from '@kortix/ui/workspace';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { bindingSpace, DEFAULT_PROJECT_DOMAIN, groupBySpace, listSpaces, type ProjectGoal } from '@kortix/sdk';
import { useProjectConfig, useProjectGoals } from '@kortix/sdk/react';
import Link from 'next/link';

/**
 * /projects/[id]/goals — every goal the viewer can see, in three groups: the
 * ones that wait on a person or need attention, the other open ones, and the
 * closed ones. Each row shows status, health, progress and the next wake, and
 * re-reads every 60 seconds (`useProjectGoals`), so an overdue wake or a
 * paused heartbeat shows up without a reload.
 */
export function GoalsPage({ projectId }: { projectId: string }) {
  const t = useTranslations('goals');
  const tSpaces = useTranslations('spaces');
  const goals = useProjectGoals(projectId);
  const config = useProjectConfig(projectId);
  const agents = config?.agents ?? [];
  // A goal sits in its bound space, else its agent's space, else Project-wide.
  const spaceOf = (goal: ProjectGoal) => bindingSpace(goal.goal, agents) ?? DEFAULT_PROJECT_DOMAIN;
  const groups = groupBySpace(goals.data ?? [], config?.domains, spaceOf);
  const labels = new Map(groups.map((group) => [group.name, group.label]));
  const spaces = listSpaces(config);
  const [space, setSpace] = useSpaceFilter(projectId);
  const all = (goals.data ?? []).filter((goal) => space === ALL_DOMAINS || spaceOf(goal) === space);
  const spaceLabel = (goal: ProjectGoal) => (space === ALL_DOMAINS ? labels.get(spaceOf(goal)) : undefined);
  const needsYou = all.filter(goalNeedsYou);
  const open = all.filter((g) => g.health.state !== 'closed' && !goalNeedsYou(g));
  const closed = all.filter((g) => g.health.state === 'closed');

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={t('title')} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-6 px-4 py-6 pb-20 md:px-8">
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
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-md" />
              ))}
            </div>
          ) : (goals.data ?? []).length === 0 ? (
            <EmptyState title={t('empty')} description={t('emptyHint')} />
          ) : (
            <>
              <SpaceFilterTabs spaces={spaces} groups={groups} value={space} onValueChange={setSpace} />
              {all.length === 0 ? (
                <EmptyState
                  size="sm"
                  title={t('spaceEmpty', { space: spaceFilterLabel(space, spaces, tSpaces('projectWide')) })}
                  action={
                    <Button size="sm" variant="outline" onClick={() => setSpace(ALL_DOMAINS)}>
                      {t('showAll')}
                    </Button>
                  }
                />
              ) : null}
              <GoalGroup projectId={projectId} title={t('needsYou')} goals={needsYou} spaceLabel={spaceLabel} />
              <GoalGroup projectId={projectId} title={t('open')} goals={open} spaceLabel={spaceLabel} />
              <GoalGroup projectId={projectId} title={t('closed')} goals={closed} spaceLabel={spaceLabel} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GoalGroup({
  projectId,
  title,
  goals,
  spaceLabel,
}: {
  projectId: string;
  title: string;
  goals: ProjectGoal[];
  /** The space chip of a row: only while every space is shown. */
  spaceLabel: (goal: ProjectGoal) => string | undefined;
}) {
  if (goals.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-muted-foreground px-3 text-xs font-medium">
        {title} <span className="tabular-nums">{goals.length}</span>
      </h2>
      <ul className="flex flex-col">
        {goals.map((goal) => (
          <GoalRow key={`${goal.scope}/${goal.slug}`} projectId={projectId} goal={goal} space={spaceLabel(goal)} />
        ))}
      </ul>
    </section>
  );
}

function GoalRow({ projectId, goal, space }: { projectId: string; goal: ProjectGoal; space?: string }) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const issueText = useGoalIssueText();
  const href = goalHref(projectId, goal);
  const doc = goal.goal;
  const progress = goalProgress(doc);
  const asks = goalOpenAsks(doc);
  const detail = goal.health.issues[0]
    ? issueText(goal.health.issues[0], goal)
    : asks[0]
      ? t('waitingFor', { title: asks[0].title })
      : goal.health.state === 'closed'
        ? doc?.summary || t(`status.${doc?.status ?? 'done'}`)
        : goal.heartbeat?.next_fire_at
          ? t('nextWake', { time: formatGoalTime(goal.heartbeat.next_fire_at, locale, now) })
          : t('noWake');

  return (
    <li>
      <Link
        href={href ?? '#'}
        className="hover:bg-hover flex items-start gap-3 rounded-md px-3 py-2.5"
        data-testid="goal-row"
      >
        <span className="mt-1.5">
          <GoalHealthDot goal={goal} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-foreground truncate text-sm">{doc?.objective ?? goal.slug}</span>
          <span className="text-muted-foreground truncate text-xs">{detail}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <span className="text-muted-foreground hidden text-xs tabular-nums sm:inline">
            {t('criteria', { met: progress.met, total: progress.total })}
          </span>
          <span className="text-muted-foreground hidden text-xs sm:inline">
            {space ? t('spaceScope', { space, scope: t(`scope.${goal.scope}`) }) : t(`scope.${goal.scope}`)}
          </span>
          <GoalStatusBadge status={doc?.status} />
        </span>
      </Link>
    </li>
  );
}
