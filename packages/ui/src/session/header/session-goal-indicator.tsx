'use client';

/**
 * Header chip for a session that works on a goal (flag `goals`). Renders
 * nothing unless the session is a goal's main session, worker or verifier.
 * The popover says which, and shows the goal's status, health, progress, the
 * heartbeat's last and next wake, and what the goal waits on a person for,
 * with a link to the goal page. The dot on the chip turns orange when the goal
 * needs attention, so a broken goal is visible from its own session.
 */

import { HoverPrefetchLink } from '../../internal/components/hover-prefetch-link';
import { useNow } from '../../internal/reminders/use-refetch-after-fire';
import { Button } from '../../primitives/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { StatusDot } from '../../primitives/status';
import { useLocale, useTranslations } from '../../i18n';
import { useFeatureFlag, useSessionGoal } from '@kortix/sdk/react';
import { TargetIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useSessionIds } from '../../providers/session-ids';
import {
  formatGoalTime,
  GoalHealthDot,
  goalHref,
  goalOpenAsks,
  goalProgress,
  GoalStatusBadge,
  useGoalIssueText,
} from '../../internal/goals/goal-meta';

export function SessionGoalIndicator() {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useNow();
  const { projectId, sessionId } = useSessionIds<{ projectId: string; sessionId: string }>();
  const gate = useFeatureFlag(projectId, 'goals');
  const { goal, role } = useSessionGoal(gate.enabled ? projectId : null, sessionId);
  const issueText = useGoalIssueText();
  const [open, setOpen] = useState(false);

  if (!goal || !role || !projectId) return null;
  const doc = goal.goal;
  const progress = goalProgress(doc);
  const asks = goalOpenAsks(doc);
  const href = goalHref(projectId, goal);
  const attention = goal.health.state === 'attention';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('sessionChip')}
          className="relative"
          data-testid="session-goal-chip"
        >
          <TargetIcon className="size-4" />
          {attention ? <StatusDot tone="warning" className="absolute top-1 right-1" /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 overflow-hidden p-0">
        <div className="flex flex-col gap-2 border-b px-4 pt-4 pb-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-foreground text-sm font-medium">{t('sessionChip')}</h3>
            <GoalStatusBadge status={doc?.status} />
          </div>
          <p className="text-foreground line-clamp-2 text-sm">{doc?.objective ?? goal.slug}</p>
          <p className="text-muted-foreground text-xs">{t(`sessionRole.${role}`)}</p>
        </div>
        <div className="flex flex-col gap-2 px-4 py-3 text-xs">
          <div className="flex items-start gap-2">
            <span className="mt-1">
              <GoalHealthDot goal={goal} />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-foreground">{t(`health.${goal.health.state}`)}</span>
              {goal.health.issues.map((issue) => (
                <span key={issue} className="text-muted-foreground">
                  {issueText(issue, goal)}
                </span>
              ))}
            </div>
          </div>
          <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt>{t('progress')}</dt>
            <dd className="text-foreground tabular-nums">{t('criteria', { met: progress.met, total: progress.total })}</dd>
            {goal.health.state !== 'closed' ? (
              <>
                <dt>{t('heartbeat')}</dt>
                <dd className="text-foreground">
                  {goal.heartbeat?.state === 'active' && goal.heartbeat.next_fire_at
                    ? t('nextWake', { time: formatGoalTime(goal.heartbeat.next_fire_at, locale, now) })
                    : t('noWake')}
                </dd>
              </>
            ) : null}
            {goal.heartbeat?.last_fired_at ? (
              <>
                <dt>{t('lastWakeLabel')}</dt>
                <dd className="text-foreground">{formatGoalTime(goal.heartbeat.last_fired_at, locale, now)}</dd>
              </>
            ) : null}
          </dl>
          {asks.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground">{t('needsYou')}</span>
              <ul className="flex flex-col gap-1">
                {asks.map((ask) => (
                  <li key={ask.id} className="text-foreground flex justify-between gap-2">
                    <span className="min-w-0 truncate">{ask.title}</span>
                    {ask.due ? <span className="text-muted-foreground shrink-0">{formatGoalTime(ask.due, locale, now)}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        {href ? (
          <div className="border-t px-4 py-2">
            <Button asChild variant="ghost" size="sm" className="w-full justify-center">
              <HoverPrefetchLink href={href} onClick={() => setOpen(false)}>
                {t('openGoal')}
              </HoverPrefetchLink>
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
