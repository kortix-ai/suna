'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  Activity,
  CalendarClock,
  ExternalLink,
  MessageSquare,
  Receipt,
  Search,
  Webhook,
} from 'lucide-react';

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
import { useGatewaySessions } from '@/hooks/projects/use-project-gateway';
import { useGatewayOverlayStore } from '@/stores/gateway-overlay-store';
import { listProjectSessions, type ProjectSession } from '@/lib/projects-client';
import type { GatewaySessionStat } from '@/lib/projects-gateway-client';
import { cn } from '@/lib/utils';

import {
  formatRunDuration,
  formatUsd,
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

  const gateway = useGatewaySessions(projectId);
  const costBySession = useMemo(() => {
    const m = new Map<string, GatewaySessionStat>();
    for (const s of gateway.data?.sessions ?? []) m.set(s.session_id, s);
    return m;
  }, [gateway.data]);
  const openGateway = useGatewayOverlayStore((s) => s.openGateway);

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

  const stats = useMemo(() => {
    const all = sessionsQuery.data ?? [];
    return {
      total: all.length,
      running: all.filter((s) => isLiveRun(s.status)).length,
      failed: all.filter((s) => s.status === 'failed').length,
    };
  }, [sessionsQuery.data]);

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <CustomizeSectionHeader
        icon={Activity}
        title="Activity"
        count={sessionsQuery.data ? runs.length : undefined}
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search runs…"
                className="h-8 w-44 pl-7 text-sm"
              />
            </div>
            <Hint label="Open the gateway spend view">
              <Button
                size="sm"
                variant="ghost"
                className="h-8 shrink-0 gap-1.5"
                onClick={() => openGateway({ section: 'cost' })}
              >
                <Receipt className="size-3.5" />
                Spend
              </Button>
            </Hint>
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
          {!sessionsQuery.isLoading && stats.total > 0 && (
            <div className="text-muted-foreground mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="text-foreground font-medium">
                {stats.total} {stats.total === 1 ? 'run' : 'runs'}
              </span>
              {stats.running > 0 && (
                <span className="flex items-center gap-1.5">
                  <StatusDot tone="info" pulse />
                  {stats.running} running
                </span>
              )}
              {stats.failed > 0 && (
                <span className="flex items-center gap-1.5">
                  <StatusDot tone="destructive" />
                  {stats.failed} failed
                </span>
              )}
            </div>
          )}
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
                <RunRow
                  key={run.session_id}
                  projectId={projectId}
                  run={run}
                  cost={costBySession.get(run.session_id)}
                />
              ))}
            </List>
          )}
        </div>
      </div>
    </div>
  );
}

function RunRow({
  projectId,
  run,
  cost,
}: {
  projectId: string;
  run: ProjectSession;
  cost?: GatewaySessionStat;
}) {
  const router = useRouter();
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
      className="cursor-pointer"
      onClick={() => router.push(`/projects/${projectId}/sessions/${run.session_id}`)}
      leading={
        <span className="bg-muted/60 text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
          <SourceIcon kind={kind} className="size-4" />
        </span>
      }
      title={<span className="truncate font-medium">{sessionDisplayLabel(run)}</span>}
      subtitle={
        <InlineMeta>
          {SOURCE_LABEL[kind]}
          {run.agent_name || null}
          {formatDistanceToNowStrict(new Date(run.created_at), { addSuffix: true })}
          {duration}
        </InlineMeta>
      }
      trailing={
        <div className="flex items-center gap-1.5">
          {live && run.sandbox_url && (
            <Hint label="Open this run's live workspace">
              <a
                href={run.sandbox_url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                aria-label="Open run workspace"
                className="text-muted-foreground hover:text-foreground hover:bg-muted/60 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </Hint>
          )}
          <div className="flex flex-col items-end gap-1">
            {run.status === 'failed' && run.error ? (
              <Hint label={run.error}>{statusBadge}</Hint>
            ) : (
              statusBadge
            )}
            {cost && cost.total_cost > 0 && (
              <Hint
                label={`LLM ${formatUsd(cost.llm_cost)} · compute ${formatUsd(cost.compute_cost)}`}
              >
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatUsd(cost.total_cost)}
                </span>
              </Hint>
            )}
          </div>
        </div>
      }
    />
  );
}
