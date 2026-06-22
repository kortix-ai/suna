'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { Activity, CalendarClock, MessageSquare, Webhook } from 'lucide-react';

import {
  matchesSessionFilter,
  sessionDisplayLabel,
  sessionSource,
  SESSION_FILTER_OPTIONS,
  type SessionFilterValue,
  type SessionSourceKind,
} from '@/components/projects/session-label';
import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import Hint from '@/components/ui/hint';
import { InlineMeta } from '@/components/ui/inline-meta';
import { List, ListRow } from '@/components/ui/list';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge, StatusDot } from '@/components/ui/status';
import { Icon } from '@/features/icon/icon';
import { listProjectSessions, type ProjectSession } from '@/lib/projects-client';
import { cn } from '@/lib/utils';

import { isLiveRun, runStatusLabel, runStatusTone } from './activity-status';

const SOURCE_LABEL: Record<SessionSourceKind, string> = {
  chat: 'Chat',
  slack: 'Slack',
  telegram: 'Telegram',
  schedule: 'Scheduled',
  webhook: 'Webhook',
};

function SourceIcon({ kind, className }: { kind: SessionSourceKind; className?: string }) {
  if (kind === 'slack') return <Icon.Slack className={className} />;
  if (kind === 'telegram') return <Icon.Telegram className={className} />;
  if (kind === 'schedule') return <CalendarClock className={className} />;
  if (kind === 'webhook') return <Webhook className={className} />;
  return <MessageSquare className={className} />;
}

export function ActivityView({ projectId }: { projectId: string }) {
  const [filter, setFilter] = useState<SessionFilterValue>('all');

  const sessionsQuery = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    enabled: !!projectId,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => isLiveRun(s.status)) ? 5000 : false,
  });

  const runs = useMemo(
    () => (sessionsQuery.data ?? []).filter((s) => matchesSessionFilter(s, filter)),
    [sessionsQuery.data, filter],
  );

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <CustomizeSectionHeader
        icon={Activity}
        title="Activity"
        count={sessionsQuery.data ? runs.length : undefined}
      />

      <div className="border-border/60 flex shrink-0 items-center gap-1 overflow-x-auto border-b px-3 py-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {SESSION_FILTER_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setFilter(opt.value)}
            aria-pressed={filter === opt.value}
            className={cn(
              'h-7 shrink-0 rounded-full',
              filter === opt.value && 'bg-primary/10 text-primary',
            )}
          >
            {opt.label}
          </Button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-5">
          {sessionsQuery.isLoading ? (
            <List>
              {Array.from({ length: 6 }).map((_, i) => (
                <ListRow
                  key={i}
                  leading={<Skeleton className="size-8 rounded-lg" />}
                  title={<Skeleton className="h-4 w-48" />}
                  subtitle={<Skeleton className="mt-1 h-3 w-32" />}
                />
              ))}
            </List>
          ) : runs.length === 0 ? (
            <EmptyState
              icon={Activity}
              title={filter === 'all' ? 'No runs yet' : 'No runs match this filter'}
              description={
                filter === 'all'
                  ? 'Sessions you start, and ones fired by schedules, webhooks or channels, will show up here.'
                  : 'Try a different filter to see other runs.'
              }
            />
          ) : (
            <List>
              {runs.map((run) => (
                <RunRow key={run.session_id} projectId={projectId} run={run} />
              ))}
            </List>
          )}
        </div>
      </div>
    </div>
  );
}

function RunRow({ projectId, run }: { projectId: string; run: ProjectSession }) {
  const kind = sessionSource(run).kind;
  const tone = runStatusTone(run.status);
  const live = isLiveRun(run.status);
  const statusBadge = (
    <StatusBadge tone={tone}>
      <StatusDot tone={tone} pulse={live} />
      {runStatusLabel(run.status)}
    </StatusBadge>
  );

  return (
    <ListRow
      leading={
        <span className="bg-muted/60 text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
          <SourceIcon kind={kind} className="size-4" />
        </span>
      }
      title={
        <Link
          href={`/projects/${projectId}/sessions/${run.session_id}`}
          className="hover:text-primary truncate font-medium"
        >
          {sessionDisplayLabel(run)}
        </Link>
      }
      subtitle={
        <InlineMeta>
          {SOURCE_LABEL[kind]}
          {run.agent_name || null}
          {formatDistanceToNowStrict(new Date(run.created_at), { addSuffix: true })}
        </InlineMeta>
      }
      trailing={
        run.status === 'failed' && run.error ? <Hint label={run.error}>{statusBadge}</Hint> : statusBadge
      }
    />
  );
}
