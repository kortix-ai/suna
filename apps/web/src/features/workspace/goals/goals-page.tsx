'use client';

import { Button } from '@kortix/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@kortix/ui/dialog';
import { Textarea } from '@kortix/ui/textarea';
import { PlusIcon } from '@phosphor-icons/react';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { Skeleton } from '@kortix/ui/skeleton';
import Loading from '@kortix/ui/loading';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@kortix/ui/tabs';
import { useUiViewerId } from '@kortix/ui';
import {
  formatGoalTime,
  goalAssignedTo,
  GoalHealthDot,
  goalHref,
  goalLastWake,
  goalNeedsAttention,
  goalNeedsYou,
  goalOpenAsks,
  goalProgress,
  GoalStatusBadge,
  ALL_SPACES,
  ProjectPageHeader,
  SpaceFilterTabs,
  spaceFilterLabel,
  useGoalClock,
  useGoalIssueText,
  useGoalPerson,
  useStartGoal,
  spaceScope,
  useSpaceFilter,
  useSpacesEnabled,
} from '@kortix/ui/workspace';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { ProjectGoal } from '@kortix/sdk';
import { useProjectConfig, useProjectGoals } from '@kortix/sdk/react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * /projects/[id]/goals — every goal the viewer can see, in three groups: the
 * ones that wait on a person or need attention, the other open ones, and the
 * closed ones. Each row shows state, health, the assigned agent and user,
 * progress and the last and next wake, and re-reads every 60 seconds
 * (`useProjectGoals`), so an overdue wake or a paused heartbeat shows up
 * without a reload. "Assigned to me" keeps the goals whose GOAL.md names the
 * viewer as `assigned_user`.
 */
export function GoalsPage({ projectId }: { projectId: string }) {
  const t = useTranslations('goals');
  const tSpaces = useTranslations('spaces');
  const goals = useProjectGoals(projectId);
  const config = useProjectConfig(projectId);
  // A goal sits in its bound space, else its agent's space, else Project-wide.
  // Spaces are Work in progress: with `project_channels` off every goal is project-wide.
  const spacesOn = useSpacesEnabled(projectId);
  const { spaces, groups, spaceOf } = spaceScope(goals.data ?? [], config, spacesOn, (goal: ProjectGoal) => goal.goal);
  const labels = new Map(groups.map((group) => [group.name, group.label]));
  const [space, setSpace] = useSpaceFilter(projectId);
  const viewerId = useUiViewerId();
  const [mine, setMine] = useState(false);
  const all = (goals.data ?? []).filter(
    (goal) => (space === ALL_SPACES || spaceOf(goal) === space) && (!mine || goalAssignedTo(goal, viewerId)),
  );
  const spaceLabel = (goal: ProjectGoal) => (spacesOn && space === ALL_SPACES ? labels.get(spaceOf(goal)) : undefined);
  const needsYou = all.filter(goalNeedsYou);
  const attention = all.filter(goalNeedsAttention);
  const open = all.filter((g) => g.health.state !== 'closed' && !goalNeedsYou(g) && !goalNeedsAttention(g));
  const [creating, setCreating] = useState(false);
  const newGoal = (
    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setCreating(true)} data-testid="goals-new">
      <PlusIcon className="size-3.5" aria-hidden />
      {t('newGoal')}
    </Button>
  );
  const closed = all.filter((g) => g.health.state === 'closed');

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={t('title')}>{(goals.data ?? []).length > 0 ? newGoal : null}</ProjectPageHeader>
      <NewGoalDialog projectId={projectId} open={creating} onOpenChange={setCreating} />
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
            <EmptyState title={t('empty')} description={t('emptyHint')} action={newGoal} />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Tabs value={mine ? 'mine' : 'all'} onValueChange={(value) => setMine(value === 'mine')}>
                  <TabsListCompact aria-label={t('assignedToMe')}>
                    <TabsTriggerCompact value="all">{t('allGoals')}</TabsTriggerCompact>
                    <TabsTriggerCompact value="mine">{t('assignedToMe')}</TabsTriggerCompact>
                  </TabsListCompact>
                </Tabs>
                <SpaceFilterTabs spaces={spaces} groups={groups} value={space} onValueChange={setSpace} />
              </div>
              {all.length === 0 && mine ? (
                <EmptyState
                  size="sm"
                  title={t('noneAssigned')}
                  action={
                    <Button size="sm" variant="outline" onClick={() => setMine(false)}>
                      {t('showAll')}
                    </Button>
                  }
                />
              ) : all.length === 0 ? (
                <EmptyState
                  size="sm"
                  title={t('spaceEmpty', { space: spaceFilterLabel(space, spaces, tSpaces('projectWide')) })}
                  action={
                    <Button size="sm" variant="outline" onClick={() => setSpace(ALL_SPACES)}>
                      {t('showAll')}
                    </Button>
                  }
                />
              ) : null}
              <GoalGroup projectId={projectId} title={t('needsYou')} goals={needsYou} spaceLabel={spaceLabel} />
              <GoalGroup projectId={projectId} title={t('needsAttention')} goals={attention} spaceLabel={spaceLabel} />
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
  const personOf = useGoalPerson(projectId);
  const viewerId = useUiViewerId();
  const href = goalHref(projectId, goal);
  const doc = goal.goal;
  const person = personOf(doc?.assigned_user);
  const lastWake = goalLastWake(goal);
  const forWhom = !doc?.assigned_user
    ? null
    : goalAssignedTo(goal, viewerId)
      ? t('forYou')
      : person && person !== t('anotherMember')
        ? t('forPerson', { person })
        : t('forMember');
  const who = [
    doc?.agent,
    forWhom,
    lastWake && goal.health.state !== 'closed' ? t('lastWake', { time: formatGoalTime(lastWake, locale, now) }) : null,
  ].filter(Boolean);
  const progress = goalProgress(doc);
  const asks = goalOpenAsks(doc);
  const detail = goal.health.issues[0]
    ? issueText(goal.health.issues[0], goal)
    : doc?.status === 'waiting_on_user' && doc.waiting_on
      ? t('waitingFor', { title: doc.waiting_on })
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
          <span className="text-muted-foreground truncate text-xs">
            {[detail, ...who].join(' · ')}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <span className="text-muted-foreground hidden text-xs tabular-nums sm:inline">
            {t('criteria', { met: progress.met, total: progress.total })}
          </span>
          {/* Goals are company goals; only a legacy personal one says so. */}
          {space || goal.scope === 'personal' ? (
            <span className="text-muted-foreground hidden text-xs sm:inline">
              {space && goal.scope === 'personal' ? t('spaceScope', { space, scope: t('scope.personal') }) : (space ?? t('scope.personal'))}
            </span>
          ) : null}
          <GoalStatusBadge status={doc?.status} />
        </span>
      </Link>
    </li>
  );
}

/** "New goal": the outcome in one box; a new session turns it into GOAL.md with done criteria. */
function NewGoalDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('goals');
  const startGoal = useStartGoal(projectId);
  const [outcome, setOutcome] = useState('');
  const [starting, setStarting] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (starting ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!outcome.trim() || starting) return;
            setStarting(true);
            startGoal(outcome);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('newGoalTitle')}</DialogTitle>
            <DialogDescription>{t('newGoalDescription')}</DialogDescription>
          </DialogHeader>
          <Textarea
            id="new-goal-outcome"
            autoFocus
            rows={4}
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
            }}
            placeholder={t('newGoalPlaceholder')}
            aria-label={t('newGoalTitle')}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" disabled={starting} onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!outcome.trim() || starting} data-testid="goals-new-start">
              {starting ? <Loading className="size-4 shrink-0" /> : null}
              {t('newGoalStart')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
