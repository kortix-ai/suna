'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { Activity, CalendarClock, MessageSquare, Search, Webhook } from 'lucide-react';

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
import { Input } from '@/components/ui/input';
import { InlineMeta } from '@/components/ui/inline-meta';
import { List, ListRow } from '@/components/ui/list';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge, StatusDot } from '@/components/ui/status';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { Icon } from '@/features/icon/icon';
import { listProjectSessions, type ProjectSession } from '@/lib/projects-client';
import { cn } from '@/lib/utils';

import {
  formatRunDuration,
  isLiveRun,
  matchesRunStatus,
  runStatusLabel,
  runStatusTone,
  RUN_STATUS_FILTERS,
  type RunStatusFilter,
} from './activity-status';

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

function matchesSearch(run: ProjectSession, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    sessionDisplayLabel(run).toLowerCase().includes(q) ||
    (run.agent_name?.toLowerCase().includes(q) ?? false)
  );
}

export function ActivityView({ projectId }: { projectId: string }) {
  const [source, setSource] = useState<SessionFilterValue>('all');
  const [status, setStatus] = useState<RunStatusFilter>('all');
  const [search, setSearch] = useState('');

  const sessionsQuery = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    enabled: !!projectId,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => isLiveRun(s.status)) ? 5000 : false,
  });

  const runs = useMemo(
    () =>
      (sessionsQuery.data ?? []).filter(
        (s) =>
          matchesSessionFilter(s, source) &&
          matchesRunStatus(s.status, status) &&
          matchesSearch(s, search),
      ),
    [sessionsQuery.data, source, status, search],
  );

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <CustomizeSectionHeader
        icon={Activity}
        title="Activity"
        count={sessionsQuery.data ? runs.length : undefined}
        actions={
          <div className="relative">
            <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search runs…"
              className="h-8 w-44 pl-7 text-sm"
            />
          </div>
        }
      />

      <div className="border-border/60 flex shrink-0 flex-wrap items-center gap-2 overflow-x-auto border-b px-3 py-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        <FilterBar className="h-8">
          {RUN_STATUS_FILTERS.map((opt) => (
            <FilterBarItem
              key={opt.value}
              data-state={status === opt.value ? 'active' : 'inactive'}
              onClick={() => setStatus(opt.value)}
            >
              {opt.label}
            </FilterBarItem>
          ))}
        </FilterBar>
        <span className="bg-border/60 mx-1 h-4 w-px shrink-0" aria-hidden />
        {SESSION_FILTER_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setSource(opt.value)}
            aria-pressed={source === opt.value}
            className={cn(
              'h-7 shrink-0 rounded-full',
              source === opt.value && 'bg-primary/10 text-primary',
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
              title={
                sessionsQuery.data?.length ? 'No runs match these filters' : 'No runs yet'
              }
              description={
                sessionsQuery.data?.length
                  ? 'Try a different status, source, or search.'
                  : 'Sessions you start, and ones fired by schedules, webhooks or channels, will show up here.'
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
  const duration = live ? null : formatRunDuration(run.created_at, run.updated_at);
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
          {duration}
        </InlineMeta>
      }
      trailing={
        run.status === 'failed' && run.error ? (
          <Hint label={run.error}>{statusBadge}</Hint>
        ) : (
          statusBadge
        )
      }
    />
  );
}
