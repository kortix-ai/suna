'use client';

import { SESSION_DISPLAY_STATUS_LABELS } from '@/components/projects/session-label';
import { StatusGlyph } from '@/components/projects/session-status-dot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { getSessionDisplayTitle } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import type { ProjectSession, ProjectTrigger } from '@kortix/sdk';
import { useFeatureFlag } from '@kortix/sdk/react';
import { AlarmIcon, CaretRightIcon, EyeIcon, WebhooksLogoIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';

import { STAGE_LABELS, sessionStage } from './stage-board-logic';
import {
  RUN_LEGEND,
  groupSessionsByTrigger,
  runDisplayStatus,
  runStrip,
  summarizeRuns,
  type TriggerRunGroup,
} from './trigger-runs-logic';

const TYPE_ICON: Record<ProjectTrigger['type'], typeof AlarmIcon> = {
  cron: AlarmIcon,
  webhook: WebhooksLogoIcon,
  monitor: EyeIcon,
};

function Legend({ totals }: { totals: { triggers: number; runs: number; failed: number } }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
      {RUN_LEGEND.map((display) => (
        <span key={display} className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <StatusGlyph display={display} />
          {SESSION_DISPLAY_STATUS_LABELS[display]}
        </span>
      ))}
      <span className="text-muted-foreground ml-auto text-xs tabular-nums">
        {totals.triggers} trigger{totals.triggers === 1 ? '' : 's'} · {totals.runs} run
        {totals.runs === 1 ? '' : 's'}
        {totals.failed > 0 ? (
          <>
            {' · '}
            <span className="text-kortix-red">{totals.failed} failed</span>
          </>
        ) : null}
      </span>
    </div>
  );
}

function RunRow({
  projectId,
  session,
  needsYouBySession,
}: {
  projectId: string;
  session: ProjectSession;
  needsYouBySession: Readonly<Record<string, number>>;
}) {
  const display = runDisplayStatus(session, needsYouBySession);
  return (
    <li className="flex items-center gap-3 border-t px-4 py-2">
      <StatusGlyph display={display} />
      <Link
        href={`/projects/${projectId}/sessions/${session.session_id}`}
        prefetch={false}
        className="text-foreground min-w-0 flex-1 truncate text-sm hover:underline"
      >
        {getSessionDisplayTitle(session)}
      </Link>
      <span className="text-muted-foreground hidden text-xs sm:inline">
        {SESSION_DISPLAY_STATUS_LABELS[display]}
      </span>
      <Badge variant="outline" size="xs">
        {STAGE_LABELS[sessionStage(session)]}
      </Badge>
      <time
        dateTime={session.created_at}
        title={session.created_at}
        className="text-muted-foreground w-14 shrink-0 text-right text-xs tabular-nums"
      >
        {relativeTime(session.created_at)}
      </time>
    </li>
  );
}

/**
 * One trigger: its name, the last runs as a strip of status glyphs (oldest →
 * newest, so it reads like a timeline), and the newest run's age. Clicking
 * the row opens every run the trigger has under it.
 */
function TriggerRow({
  projectId,
  group,
  needsYouBySession,
}: {
  projectId: string;
  group: TriggerRunGroup;
  needsYouBySession: Readonly<Record<string, number>>;
}) {
  const [open, setOpen] = useState(false);
  const trigger = group.trigger;
  const Icon = trigger ? TYPE_ICON[trigger.type] : AlarmIcon;
  const latest = group.sessions[0];
  const strip = runStrip(group);
  const panelId = `trigger-runs-${group.slug}`;

  return (
    <li className="bg-popover rounded-md border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'hover:bg-muted/40 flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors',
          open && 'rounded-b-none',
        )}
      >
        <CaretRightIcon
          className={cn(
            'text-muted-foreground size-3.5 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        />
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
          {trigger?.name ?? group.slug}
        </span>
        {trigger && !trigger.enabled ? (
          <Badge variant="muted" size="xs">
            Disabled
          </Badge>
        ) : null}
        {!trigger ? (
          <Badge variant="muted" size="xs">
            Not in manifest
          </Badge>
        ) : null}
        {strip.length === 0 ? (
          <span className="text-muted-foreground text-xs">No runs yet</span>
        ) : (
          <span className="flex items-center gap-1.5" aria-label={`${group.sessions.length} runs`}>
            {strip.map((session) => {
              const display = runDisplayStatus(session, needsYouBySession);
              return (
                <Hint
                  key={session.session_id}
                  side="top"
                  label={
                    <span className="text-xs">
                      {getSessionDisplayTitle(session)} · {SESSION_DISPLAY_STATUS_LABELS[display]}
                    </span>
                  }
                >
                  <span className="flex size-4 items-center justify-center">
                    <StatusGlyph display={display} />
                  </span>
                </Hint>
              );
            })}
          </span>
        )}
        <time
          dateTime={latest?.created_at ?? trigger?.last_fired_at ?? undefined}
          className="text-muted-foreground w-14 shrink-0 text-right text-xs whitespace-nowrap tabular-nums"
        >
          {latest ? relativeTime(latest.created_at) : ''}
        </time>
      </button>
      {open ? (
        <ul id={panelId}>
          {group.sessions.length === 0 ? (
            <li className="text-muted-foreground border-t px-4 py-3 text-xs">
              {trigger?.enabled === false
                ? 'This trigger is disabled. Enable it under Customize → Triggers to start runs.'
                : 'No runs yet. Fire the trigger or wait for its next schedule.'}
            </li>
          ) : (
            group.sessions.map((session) => (
              <RunRow
                key={session.session_id}
                projectId={projectId}
                session={session}
                needsYouBySession={needsYouBySession}
              />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

/** Every trigger as one row; open a row to see all of its runs. */
export function TriggerRuns({
  projectId,
  sessions,
  triggers,
}: {
  projectId: string;
  sessions: readonly ProjectSession[];
  triggers: readonly ProjectTrigger[];
}) {
  // Same "needs you" source as the sidebar, so a run that is waiting on a
  // review here is the same run that carries the badge there.
  const reviewGate = useFeatureFlag(projectId, 'review_center');
  const review = useReviewSessionSummary(projectId, { enabled: reviewGate.enabled });
  const needsYouBySession = review.needsYouBySession;

  const groups = groupSessionsByTrigger(sessions, triggers);
  if (groups.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={AlarmIcon}
        title="No triggers"
        description="Sessions started by a schedule, webhook, or monitor will be listed here under their trigger."
        action={
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link href={`/projects/${projectId}/customize/triggers`} prefetch={false}>
              Set up a trigger
            </Link>
          </Button>
        }
      />
    );
  }
  const totals = summarizeRuns(groups, needsYouBySession);
  return (
    <div className="space-y-3">
      <Legend totals={totals} />
      <ul className="space-y-2">
        {groups.map((group) => (
          <TriggerRow
            key={group.slug}
            projectId={projectId}
            group={group}
            needsYouBySession={needsYouBySession}
          />
        ))}
      </ul>
    </div>
  );
}
