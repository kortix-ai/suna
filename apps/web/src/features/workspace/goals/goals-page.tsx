'use client';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { ProjectGoal } from '@kortix/sdk';
import { useProjectConfig, useProjectGoals } from '@kortix/sdk/react';
import { useUiViewerId } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { CountBadge } from '@kortix/ui/count-badge';
import { EmptyArt } from '@kortix/ui/empty-art';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { Skeleton } from '@kortix/ui/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@kortix/ui/tabs';
import {
  ALL_SPACES,
  goalAssignedTo,
  GoalCriteriaProgress,
  goalHref,
  goalIconState,
  goalNeedsAttention,
  goalNeedsYou,
  goalPaused,
  goalProgress,
  GoalStatusIcon,
  ProjectPageHeader,
  spaceFilterLabel,
  SpaceFilterTabs,
  spaceScope,
  useGoalClock,
  useGoalPerson,
  useGoalStateText,
  useSpaceFilter,
  useSpacesEnabled,
} from '@kortix/ui/workspace';
import { PlusIcon, TargetIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';
import { EMPTY_GOAL_DRAFT, GoalStarter, type GoalDraft } from './goal-starter';
import { NewGoalModal, type NewGoalView } from './new-goal-modal';

/**
 * /projects/[id]/goals — every goal the viewer can see, grouped by who acts
 * next: the goals that need the viewer, the ones with a problem, the ones the
 * agent is working, the paused ones, and the closed ones. Each row says in
 * one sentence where the goal stands and what happens next
 * (`useGoalStateText`, the same sentence the goal's page leads with), and
 * re-reads every 60 seconds (`useProjectGoals`), so an overdue wake shows up
 * without a reload. "Assigned to me" keeps the goals whose GOAL.md names the
 * viewer as `assigned_user`.
 */
export function GoalsPage({ projectId }: { projectId: string }) {
  const t = useTranslations('goals');
  const tSpaces = useTranslations('spaces');
  const goals = useProjectGoals(projectId);
  const config = useProjectConfig(projectId);
  // A goal sits in its bound space, else its agent's space, else Project-wide.
  // Spaces are Work in progress: with `chat` off every goal is project-wide.
  const spacesOn = useSpacesEnabled(projectId);
  const { spaces, groups, spaceOf } = spaceScope(
    goals.data ?? [],
    config,
    spacesOn,
    (goal: ProjectGoal) => goal.goal,
  );
  const labels = new Map(groups.map((group) => [group.name, group.label]));
  const [space, setSpace] = useSpaceFilter(projectId);
  const viewerId = useUiViewerId();
  const [mine, setMine] = useState(false);
  // The modal opens on the templates from the header, on the written-out form from the empty page's Start fresh.
  const [creating, setCreating] = useState(false);
  const [createView, setCreateView] = useState<NewGoalView>('templates');
  // The empty page's composer: Start fresh carries it into the form.
  const [draft, setDraft] = useState<GoalDraft>(EMPTY_GOAL_DRAFT);
  const [starting, setStarting] = useState(false);
  const openCreate = (view: NewGoalView) => {
    setCreateView(view);
    setCreating(true);
  };
  const all = (goals.data ?? []).filter(
    (goal) =>
      (space === ALL_SPACES || spaceOf(goal) === space) &&
      (!mine || goalAssignedTo(goal, viewerId)),
  );
  const spaceLabel = (goal: ProjectGoal) =>
    spacesOn && space === ALL_SPACES ? labels.get(spaceOf(goal)) : undefined;
  const needsYou = all.filter(goalNeedsYou);
  const attention = all.filter(goalNeedsAttention);
  const paused = all.filter(goalPaused);
  const working = all.filter(
    (g) =>
      g.health.state !== 'closed' && !goalNeedsYou(g) && !goalNeedsAttention(g) && !goalPaused(g),
  );
  const closed = all.filter((g) => g.health.state === 'closed');
  const hasGoals = (goals.data ?? []).length > 0;
  const newGoal = (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5"
      onClick={() => openCreate('templates')}
      data-testid="goals-new"
    >
      <PlusIcon className="size-3.5 shrink-0" aria-hidden />
      {t('newGoal')}
    </Button>
  );

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={t('title')}>{hasGoals ? newGoal : null}</ProjectPageHeader>
      <NewGoalModal
        projectId={projectId}
        open={creating}
        initialView={createView}
        initialDraft={createView === 'form' ? draft : EMPTY_GOAL_DRAFT}
        onOpenChange={setCreating}
        onDraftChange={setDraft}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-8 px-4 py-6 pb-20 md:px-8">
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
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-md" />
              ))}
            </div>
          ) : !hasGoals ? (
            <section
              className="flex flex-col gap-6 pt-4 md:pt-10"
              aria-labelledby="goals-start-title"
              data-testid="goals-empty"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <h2
                    id="goals-start-title"
                    className="text-foreground text-lg font-medium text-balance"
                  >
                    {t('galleryTitle')}
                  </h2>
                  <p className="text-muted-foreground text-sm text-pretty">
                    {t('galleryDescription')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 rounded-full"
                  disabled={starting}
                  onClick={() => openCreate('form')}
                  data-testid="goals-start-fresh"
                >
                  {t('startFresh')}
                </Button>
              </div>
              <GoalStarter
                projectId={projectId}
                draft={draft}
                onDraftChange={setDraft}
                onPendingChange={setStarting}
              />
            </section>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Tabs
                  value={mine ? 'mine' : 'all'}
                  onValueChange={(value) => setMine(value === 'mine')}
                >
                  <TabsListCompact aria-label={t('assignedToMe')}>
                    <TabsTriggerCompact value="all">{t('allGoals')}</TabsTriggerCompact>
                    <TabsTriggerCompact value="mine">{t('assignedToMe')}</TabsTriggerCompact>
                  </TabsListCompact>
                </Tabs>
                <SpaceFilterTabs
                  spaces={spaces}
                  groups={groups}
                  value={space}
                  onValueChange={setSpace}
                />
              </div>
              {all.length === 0 ? (
                <EmptyState
                  size="sm"
                  media={<EmptyArt icon={TargetIcon} />}
                  title={
                    mine
                      ? t('noneAssigned')
                      : t('spaceEmpty', {
                          space: spaceFilterLabel(space, spaces, tSpaces('projectWide')),
                        })
                  }
                  action={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => (mine ? setMine(false) : setSpace(ALL_SPACES))}
                    >
                      {t('showAll')}
                    </Button>
                  }
                />
              ) : null}
              <GoalGroup
                projectId={projectId}
                title={t('needsYou')}
                goals={needsYou}
                spaceLabel={spaceLabel}
                countTone="waiting"
              />
              <GoalGroup
                projectId={projectId}
                title={t('needsAttention')}
                goals={attention}
                spaceLabel={spaceLabel}
              />
              <GoalGroup
                projectId={projectId}
                title={t('working')}
                goals={working}
                spaceLabel={spaceLabel}
              />
              <GoalGroup
                projectId={projectId}
                title={t('pausedGroup')}
                goals={paused}
                spaceLabel={spaceLabel}
              />
              <GoalGroup
                projectId={projectId}
                title={t('closed')}
                goals={closed}
                spaceLabel={spaceLabel}
              />
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
  countTone = 'neutral',
}: {
  projectId: string;
  title: string;
  goals: ProjectGoal[];
  countTone?: 'waiting' | 'neutral';
  /** The space of a row: only while every space is shown. */
  spaceLabel: (goal: ProjectGoal) => string | undefined;
}) {
  if (goals.length === 0) return null;
  return (
    <section className="flex flex-col gap-1" aria-label={title}>
      <h2 className="text-muted-foreground flex items-center gap-1.5 px-3 text-xs font-medium">
        {title}
        <CountBadge count={goals.length} tone={countTone} />
      </h2>
      <ul className="flex flex-col">
        {goals.map((goal) => (
          <GoalRow
            key={`${goal.scope}/${goal.slug}`}
            projectId={projectId}
            goal={goal}
            space={spaceLabel(goal)}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * One goal: the outcome, where it stands or the question it waits on, who it
 * is for, and criteria met. No state chip: the group heading and the sentence
 * already say it.
 */
function GoalRow({
  projectId,
  goal,
  space,
}: {
  projectId: string;
  goal: ProjectGoal;
  space?: string;
}) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const stateText = useGoalStateText();
  const personOf = useGoalPerson(projectId);
  const viewerId = useUiViewerId();
  const doc = goal.goal;
  const forWhom = !doc?.assigned_user
    ? null
    : goalAssignedTo(goal, viewerId)
      ? t('forYou')
      : personOf(doc.assigned_user) && personOf(doc.assigned_user) !== t('anotherMember')
        ? t('forPerson', { person: personOf(doc.assigned_user) ?? '' })
        : t('forMember');
  const progress = goalProgress(doc);
  const meta = [
    typeof doc?.agent === 'string' ? doc.agent : null,
    forWhom,
    space,
    goal.scope === 'company' ? t('scope.company') : null,
  ].filter(Boolean);

  return (
    <li>
      <Link
        href={goalHref(projectId, goal) ?? '#'}
        className="hover:bg-hover flex items-start gap-3 rounded-md px-3 py-2.5"
        data-testid="goal-row"
      >
        <GoalStatusIcon
          state={goalIconState(goal)}
          progress={progress.total ? progress.met / progress.total : 0}
          className="mt-0.5"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-foreground truncate text-sm">{doc?.objective ?? goal.slug}</span>
          {/* The sentence gives way first: who it is for stays readable beside a long question. */}
          <span className="text-muted-foreground flex min-w-0 text-xs">
            <span className="min-w-0 truncate">{stateText(goal, locale, now)}</span>
            {meta.length ? (
              <span className="shrink-0 whitespace-nowrap">&nbsp;· {meta.join(' · ')}</span>
            ) : null}
          </span>
        </span>
        <span className="hidden shrink-0 self-center sm:inline-flex">
          {/* The icon's pie draws the progress; the row keeps the number. */}
          <GoalCriteriaProgress goal={doc} ring={false} />
        </span>
      </Link>
    </li>
  );
}
