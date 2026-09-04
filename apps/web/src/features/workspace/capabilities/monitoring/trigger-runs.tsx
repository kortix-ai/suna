'use client';

import {
  SESSION_DISPLAY_STATUS_LABELS,
  sessionDisplayStatus,
} from '@/components/projects/session-label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import { getSessionDisplayTitle } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { relativeTime } from '@/lib/relative-time';
import type { ProjectSession, ProjectTrigger } from '@kortix/sdk';
import { AlarmIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { STAGE_LABELS, sessionStage } from './stage-board-logic';
import { groupSessionsByTrigger, type TriggerRunGroup } from './trigger-runs-logic';

function statusVariant(session: ProjectSession): 'success' | 'warning' | 'destructive' | 'muted' {
  switch (sessionDisplayStatus(session)) {
    case 'running':
      return 'success';
    case 'starting':
      return 'warning';
    case 'failed':
      return 'destructive';
    default:
      return 'muted';
  }
}

function RunRow({ projectId, session }: { projectId: string; session: ProjectSession }) {
  const status = sessionDisplayStatus(session);
  return (
    <li className="flex items-center gap-3 border-t px-4 py-2">
      <Link
        href={`/projects/${projectId}/sessions/${session.session_id}`}
        prefetch={false}
        className="text-foreground min-w-0 flex-1 truncate text-sm hover:underline"
      >
        {getSessionDisplayTitle(session)}
      </Link>
      <Badge variant={statusVariant(session)} size="xs">
        {SESSION_DISPLAY_STATUS_LABELS[status]}
      </Badge>
      <Badge variant="outline" size="xs">
        {STAGE_LABELS[sessionStage(session)]}
      </Badge>
      <time
        dateTime={session.created_at}
        title={session.created_at}
        className="text-muted-foreground w-16 shrink-0 text-right text-xs tabular-nums"
      >
        {relativeTime(session.created_at)}
      </time>
    </li>
  );
}

function TriggerBlock({ projectId, group }: { projectId: string; group: TriggerRunGroup }) {
  const trigger = group.trigger;
  return (
    <section className="bg-popover rounded-md border">
      <header className="flex flex-wrap items-center gap-2 px-4 py-3">
        <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
          {trigger?.name ?? group.slug}
        </span>
        {trigger ? (
          <>
            <Badge variant="outline" size="xs">
              {trigger.type}
            </Badge>
            {!trigger.enabled ? (
              <Badge variant="muted" size="xs">
                Disabled
              </Badge>
            ) : null}
          </>
        ) : (
          <Badge variant="muted" size="xs">
            Not in manifest
          </Badge>
        )}
        <span className="text-muted-foreground text-xs">
          {trigger?.last_fired_at
            ? `Last fired ${relativeTime(trigger.last_fired_at)}`
            : `${group.sessions.length} run${group.sessions.length === 1 ? '' : 's'}`}
        </span>
      </header>
      {group.sessions.length === 0 ? (
        <p className="text-muted-foreground border-t px-4 py-3 text-xs">No runs yet.</p>
      ) : (
        <ul>
          {group.sessions.map((session) => (
            <RunRow key={session.session_id} projectId={projectId} session={session} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One block per trigger with the sessions it created, newest first. */
export function TriggerRuns({
  projectId,
  sessions,
  triggers,
}: {
  projectId: string;
  sessions: readonly ProjectSession[];
  triggers: readonly ProjectTrigger[];
}) {
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
  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <TriggerBlock key={group.slug} projectId={projectId} group={group} />
      ))}
    </div>
  );
}
