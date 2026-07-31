'use client';

import {
  CaretRightIcon as CaretRight,
  DownloadIcon as Download,
  FunnelIcon as Funnel,
  MagnifyingGlassIcon as Search,
  XIcon as X,
} from '@phosphor-icons/react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type Dispatch, type ReactNode, type SetStateAction, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { getSupabaseAccessTokenWithRetry } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';
import { type IamAuditEvent, listAuditEvents } from '@/lib/iam-client';
import { cn } from '@/lib/utils';
import {
  downloadAccountAudit,
  listAccountMembers,
  listProjectSessions,
  listProjectsForAccount,
} from '@kortix/sdk';
import {
  type HumanizedAuditAction,
  formatResourcePill,
  humanizeAuditAction,
} from './audit-display-helpers';

type ActorType = NonNullable<IamAuditEvent['actor_type']>;
type Outcome = NonNullable<IamAuditEvent['outcome']>;

interface AuditFilterState {
  action: string;
  actor: string;
  actorType: ActorType | '';
  projectId: string;
  sessionId: string;
  source: string;
  outcome: Outcome | '';
  resourceType: string;
  q: string;
  since: string;
  until: string;
}

const EMPTY_FILTER: AuditFilterState = {
  action: '',
  actor: '',
  actorType: '',
  projectId: '',
  sessionId: '',
  source: '',
  outcome: '',
  resourceType: '',
  q: '',
  since: '',
  until: '',
};

const QUICK_FILTERS: Array<{
  label: string;
  action?: string;
  actorType?: ActorType;
  outcome?: Outcome;
  resourceType?: string;
}> = [
  { label: 'All activity' },
  { label: 'People', actorType: 'human' },
  { label: 'Agents', actorType: 'agent' },
  { label: 'Sessions', resourceType: 'project_session' },
  { label: 'Connectors', action: 'executor.' },
  { label: 'Computer', action: 'computer.' },
  { label: 'Failures', outcome: 'failure' },
];

const RESOURCE_TYPES = [
  { label: 'Any resource', value: '' },
  { label: 'Project', value: 'project' },
  { label: 'Session', value: 'project_session' },
  { label: 'Connector action', value: 'connector_action' },
  { label: 'Connector approval', value: 'connector_approval' },
  { label: 'Computer', value: 'computer_tunnel' },
  { label: 'Secret', value: 'project_secret' },
  { label: 'Group', value: 'group' },
  { label: 'Account', value: 'account' },
  { label: 'Service account', value: 'service_account' },
  { label: 'Trigger', value: 'trigger' },
];

const SOURCES = [
  { label: 'Any source', value: '' },
  { label: 'Web', value: 'web' },
  { label: 'CLI', value: 'cli' },
  { label: 'SDK', value: 'sdk' },
  { label: 'Agent', value: 'agent' },
  { label: 'Executor', value: 'executor' },
  { label: 'Automation', value: 'automation' },
  { label: 'Slack', value: 'slack' },
  { label: 'Teams', value: 'teams' },
  { label: 'Email', value: 'email' },
  { label: 'Computer', value: 'computer' },
  { label: 'API', value: 'api' },
  { label: 'System', value: 'system' },
];

const KIND_DOT_TOKEN: Record<HumanizedAuditAction['kind'], string> = {
  create: 'bg-kortix-green',
  update: 'bg-kortix-yellow',
  delete: 'bg-kortix-red',
  grant: 'bg-kortix-green',
  revoke: 'bg-kortix-red',
  attach: 'bg-kortix-blue',
  detach: 'bg-muted-foreground/40',
  read: 'bg-muted-foreground/30',
  export: 'bg-kortix-blue',
  other: 'bg-muted-foreground/30',
};

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  if (!local) return '';
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function isQuickFilterActive(filter: AuditFilterState, preset: (typeof QUICK_FILTERS)[number]) {
  return (
    filter.action === (preset.action ?? '') &&
    filter.actorType === (preset.actorType ?? '') &&
    filter.outcome === (preset.outcome ?? '') &&
    filter.resourceType === (preset.resourceType ?? '')
  );
}

function applyQuickFilter(
  filter: AuditFilterState,
  preset: (typeof QUICK_FILTERS)[number],
): AuditFilterState {
  return {
    ...filter,
    action: preset.action ?? '',
    actorType: preset.actorType ?? '',
    outcome: preset.outcome ?? '',
    resourceType: preset.resourceType ?? '',
  };
}

export function AuditTab({ accountId }: { accountId: string }) {
  const [filter, setFilter] = useState<AuditFilterState>(EMPTY_FILTER);
  const [qInput, setQInput] = useState('');
  const [exporting, setExporting] = useState(false);

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 30_000,
  });
  const projectsQuery = useQuery({
    queryKey: ['audit-projects', accountId],
    queryFn: () => listProjectsForAccount(accountId),
    staleTime: 30_000,
  });
  const sessionsQuery = useQuery({
    queryKey: ['audit-project-sessions', filter.projectId],
    queryFn: () => listProjectSessions(filter.projectId, { scope: 'project' }),
    enabled: !!filter.projectId,
    staleTime: 15_000,
  });

  const emailByUserId = useMemo(
    () =>
      new Map(
        (membersQuery.data ?? [])
          .filter((member) => !!member.email)
          .map((member) => [member.user_id, member.email as string]),
      ),
    [membersQuery.data],
  );
  const projectNameById = useMemo(
    () => new Map((projectsQuery.data ?? []).map((project) => [project.project_id, project.name])),
    [projectsQuery.data],
  );

  const filterCount = [
    filter.actor,
    filter.actorType,
    filter.projectId,
    filter.sessionId,
    filter.source,
    filter.outcome,
    filter.resourceType,
    filter.q,
    filter.since,
    filter.until,
    filter.action,
  ].filter(Boolean).length;
  const hasFilter = filterCount > 0;

  const query = useInfiniteQuery({
    queryKey: ['audit', accountId, filter],
    queryFn: ({ pageParam }) =>
      listAuditEvents(accountId, {
        action: filter.action || undefined,
        actor: filter.actor || undefined,
        actor_type: filter.actorType || undefined,
        project_id: filter.projectId || undefined,
        session_id: filter.sessionId || undefined,
        source: filter.source || undefined,
        outcome: filter.outcome || undefined,
        resource_type: filter.resourceType || undefined,
        q: filter.q || undefined,
        since: filter.since || undefined,
        until: filter.until || undefined,
        cursor: pageParam,
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });

  const events = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.events),
    [query.data],
  );

  async function exportEvents(format: 'csv' | 'jsonl') {
    setExporting(true);
    try {
      const token = await getSupabaseAccessTokenWithRetry();
      if (!token) {
        errorToast('Not signed in');
        return;
      }
      const result = await downloadAccountAudit(
        accountId,
        {
          format,
          action: filter.action || undefined,
          actor: filter.actor || undefined,
          actor_type: filter.actorType || undefined,
          project_id: filter.projectId || undefined,
          session_id: filter.sessionId || undefined,
          source: filter.source || undefined,
          outcome: filter.outcome || undefined,
          resource_type: filter.resourceType || undefined,
          q: filter.q || undefined,
          since: filter.since || undefined,
          until: filter.until || undefined,
        },
        {
          backendUrl: getEnv().BACKEND_URL ?? '',
          accessToken: token,
        },
      );

      const downloadUrl = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = result.filename ?? `audit-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
      successToast(
        result.capped
          ? `Exported ${result.rowCount ?? '?'} events. Add filters to export older events.`
          : `Exported ${result.rowCount ?? '?'} events`,
      );
    } catch (error) {
      errorToast((error as Error).message || 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  function clearFilters() {
    setFilter(EMPTY_FILTER);
    setQInput('');
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">Audit log</p>
          <p className="text-muted-foreground max-w-2xl text-xs leading-relaxed">
            Reconstruct activity across people, agents, sessions, API requests, connectors, and
            computers.
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" disabled={exporting} className="gap-1.5">
              {exporting ? <Loading className="size-4" /> : <Download className="size-4" />}
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={() => exportEvents('csv')}>Download CSV</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => exportEvents('jsonl')}>
              Download JSONL
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <FilterBar className="h-auto flex-wrap justify-start">
        {QUICK_FILTERS.map((preset) => (
          <FilterBarItem
            key={preset.label}
            onClick={() => setFilter((current) => applyQuickFilter(current, preset))}
            data-state={isQuickFilterActive(filter, preset) ? 'active' : 'inactive'}
          >
            {preset.label}
          </FilterBarItem>
        ))}
      </FilterBar>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={qInput}
            onChange={(event) => setQInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                setFilter((current) => ({ ...current, q: qInput.trim() }));
              }
            }}
            onBlur={() => setFilter((current) => ({ ...current, q: qInput.trim() }))}
            placeholder="Search action, project, session, request, or correlation ID"
            aria-label="Search audit events"
            className="h-9 pl-8"
          />
        </div>

        <Select
          value={filter.projectId || 'all'}
          onValueChange={(value) =>
            setFilter((current) => ({
              ...current,
              projectId: value === 'all' ? '' : value,
              sessionId: '',
            }))
          }
        >
          <SelectTrigger size="sm" className="h-9 w-[210px]">
            <SelectValue placeholder="Project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {(projectsQuery.data ?? []).map((project) => (
              <SelectItem key={project.project_id} value={project.project_id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filter.sessionId || 'all'}
          disabled={!filter.projectId}
          onValueChange={(value) =>
            setFilter((current) => ({
              ...current,
              sessionId: value === 'all' ? '' : value,
            }))
          }
        >
          <SelectTrigger size="sm" className="h-9 w-[220px]">
            <SelectValue placeholder={filter.projectId ? 'All sessions' : 'Select project first'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sessions</SelectItem>
            {(sessionsQuery.data ?? []).map((session) => (
              <SelectItem
                key={session.session_id}
                value={session.session_id}
                description={session.session_id}
              >
                {session.name || `Session ${session.session_id.slice(0, 8)}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <AdvancedFilters
          filter={filter}
          members={membersQuery.data ?? []}
          onChange={setFilter}
          count={filterCount}
        />

        {hasFilter ? (
          <Button variant="ghost" size="sm" className="h-9 gap-1.5" onClick={clearFilters}>
            <X className="size-4" />
            Clear
          </Button>
        ) : null}
      </div>

      {query.isError ? (
        <ErrorState
          size="sm"
          title="Failed to load audit events"
          description={(query.error as Error)?.message}
          action={
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              Retry
            </Button>
          }
        />
      ) : null}

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full rounded-md" />
          ))}
        </div>
      ) : null}

      {!query.isLoading && !query.isError && events.length === 0 ? (
        <EmptyState
          icon={Search}
          size="sm"
          title="No events match these filters"
          description="Clear a filter or select a wider time range."
        />
      ) : null}

      {!query.isLoading && !query.isError && events.length > 0 ? (
        <div className="border-border overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Event</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Principal</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead className="text-right">Occurred</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <AuditRow
                  key={event.event_id}
                  event={event}
                  actorEmail={
                    event.actor_user_id ? (emailByUserId.get(event.actor_user_id) ?? null) : null
                  }
                  projectName={
                    event.project_id ? (projectNameById.get(event.project_id) ?? null) : null
                  }
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="gap-1.5"
          >
            {query.isFetchingNextPage ? <Loading className="size-3.5" /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AdvancedFilters({
  filter,
  members,
  onChange,
  count,
}: {
  filter: AuditFilterState;
  members: Array<{ user_id: string; email?: string | null }>;
  onChange: Dispatch<SetStateAction<AuditFilterState>>;
  count: number;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-1.5">
          <Funnel className="size-4" />
          Filters
          {count > 0 ? (
            <Badge variant="muted" size="xs" className="ml-0.5 tabular-nums">
              {count}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(44rem,calc(100vw-2rem))] space-y-4 p-4">
        <div>
          <p className="text-foreground text-sm font-medium">Filter activity</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Combine fields to reconstruct one actor, session, or request path.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FilterField label="Principal type">
            <Select
              value={filter.actorType || 'all'}
              onValueChange={(value) =>
                onChange((current) => ({
                  ...current,
                  actorType: value === 'all' ? '' : (value as ActorType),
                }))
              }
            >
              <SelectTrigger size="sm" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any principal</SelectItem>
                <SelectItem value="human">Person</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
                <SelectItem value="service_account">Service account</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label="Person">
            <Select
              value={filter.actor || 'all'}
              onValueChange={(value) =>
                onChange((current) => ({
                  ...current,
                  actor: value === 'all' ? '' : value,
                }))
              }
            >
              <SelectTrigger size="sm" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                {members.map((member) => (
                  <SelectItem key={member.user_id} value={member.user_id}>
                    {member.email ?? member.user_id.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label="Source">
            <Select
              value={filter.source || 'all'}
              onValueChange={(value) =>
                onChange((current) => ({
                  ...current,
                  source: value === 'all' ? '' : value,
                }))
              }
            >
              <SelectTrigger size="sm" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCES.map((source) => (
                  <SelectItem key={source.value || 'all'} value={source.value || 'all'}>
                    {source.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label="Outcome">
            <Select
              value={filter.outcome || 'all'}
              onValueChange={(value) =>
                onChange((current) => ({
                  ...current,
                  outcome: value === 'all' ? '' : (value as Outcome),
                }))
              }
            >
              <SelectTrigger size="sm" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any outcome</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="denied">Denied</SelectItem>
                <SelectItem value="failure">Failure</SelectItem>
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label="Resource">
            <Select
              value={filter.resourceType || 'all'}
              onValueChange={(value) =>
                onChange((current) => ({
                  ...current,
                  resourceType: value === 'all' ? '' : value,
                }))
              }
            >
              <SelectTrigger size="sm" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESOURCE_TYPES.map((resource) => (
                  <SelectItem key={resource.value || 'all'} value={resource.value || 'all'}>
                    {resource.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label="From">
            <Input
              type="datetime-local"
              value={filter.since ? toLocalInput(filter.since) : ''}
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  since: fromLocalInput(event.target.value),
                }))
              }
              className="h-9 w-full"
            />
          </FilterField>

          <FilterField label="To">
            <Input
              type="datetime-local"
              value={filter.until ? toLocalInput(filter.until) : ''}
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  until: fromLocalInput(event.target.value),
                }))
              }
              className="h-9 w-full"
            />
          </FilterField>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}

function AuditRow({
  event,
  actorEmail,
  projectName,
}: {
  event: IamAuditEvent;
  actorEmail: string | null;
  projectName: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const occurred = new Date(event.occurred_at);
  const human = humanizeAuditAction(event.action);
  const resource = formatResourcePill(event.resource_type, event.resource_id);
  const actorLabel =
    actorEmail ?? event.actor_user_id ?? (event.actor_type === 'system' ? 'System' : 'Unknown');
  const scopeLabel =
    projectName ?? (event.project_id ? `Project ${event.project_id.slice(0, 8)}` : 'Account');

  return (
    <>
      <TableRow
        className="cursor-pointer"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(keyboardEvent) => {
          if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
            keyboardEvent.preventDefault();
            setExpanded((value) => !value);
          }
        }}
      >
        <TableCell className="max-w-[340px] whitespace-normal">
          <div className="flex min-w-0 items-center gap-2">
            <CaretRight
              className={cn(
                'text-muted-foreground size-3.5 shrink-0 transition-transform duration-150',
                expanded && 'rotate-90',
              )}
            />
            <span
              className={cn('size-1.5 shrink-0 rounded-full', KIND_DOT_TOKEN[human.kind])}
              aria-hidden
            />
            <span className="text-foreground truncate text-sm font-medium">{human.title}</span>
            {human.detail ? (
              <code className="bg-muted/50 text-muted-foreground truncate rounded px-1.5 py-0.5 font-mono text-[11px]">
                {human.detail}
              </code>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="max-w-[220px] whitespace-normal">
          <p className="text-foreground truncate text-xs">{scopeLabel}</p>
          {event.session_id ? (
            <p className="text-muted-foreground truncate font-mono text-[11px]">
              Session {event.session_id.slice(0, 8)}
            </p>
          ) : null}
        </TableCell>
        <TableCell className="max-w-[220px] whitespace-normal">
          <p className="text-foreground truncate text-xs">{actorLabel}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {event.actor_type ? (
              <Badge variant="muted" size="xs" className="capitalize">
                {event.actor_type.replace('_', ' ')}
              </Badge>
            ) : null}
            {event.source ? (
              <Badge variant="outline" size="xs" className="capitalize">
                {event.source.replace('_', ' ')}
              </Badge>
            ) : null}
          </div>
        </TableCell>
        <TableCell>
          <OutcomeBadge outcome={event.outcome} status={event.http_status} />
        </TableCell>
        <TableCell
          className="text-muted-foreground text-right text-xs tabular-nums"
          title={occurred.toLocaleString()}
        >
          {formatRelative(occurred)}
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-muted/10 space-y-4 p-4 whitespace-normal">
            <div className="grid gap-3 md:grid-cols-2">
              <DetailBlock label="Raw action" value={event.action} />
              <DetailBlock
                label="Resource"
                value={
                  resource
                    ? `${resource}${event.resource_id ? ` · ${event.resource_id}` : ''}`
                    : '—'
                }
              />
            </div>
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
              <Detail label="Event ID" value={event.event_id} />
              <Detail label="Request ID" value={event.request_id} />
              <Detail label="Trace ID" value={event.trace_id} />
              <Detail label="Correlation ID" value={event.correlation_id} />
              <Detail label="Project ID" value={event.project_id} />
              <Detail label="Session ID" value={event.session_id} />
              <Detail
                label="HTTP"
                value={
                  event.http_status != null
                    ? `${event.http_status}${event.duration_ms != null ? ` · ${event.duration_ms} ms` : ''}`
                    : null
                }
              />
              <Detail label="Occurred at" value={occurred.toISOString()} />
            </div>
            {event.before !== null || event.after !== null ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <JsonPane label="Before" data={event.before} />
                <JsonPane label="After" data={event.after} />
              </div>
            ) : null}
            {event.metadata && Object.keys(event.metadata).length > 0 ? (
              <JsonPane label="Metadata" data={event.metadata} />
            ) : null}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function OutcomeBadge({
  outcome,
  status,
}: {
  outcome: IamAuditEvent['outcome'];
  status: number | null;
}) {
  if (!outcome) {
    return status != null ? (
      <Badge variant="muted" size="xs" className="tabular-nums">
        {status}
      </Badge>
    ) : (
      <span className="text-muted-foreground text-xs">—</span>
    );
  }
  const variant: 'success' | 'warning' | 'destructive' | 'muted' =
    outcome === 'success'
      ? 'success'
      : outcome === 'pending'
        ? 'warning'
        : outcome === 'denied' || outcome === 'failure'
          ? 'destructive'
          : 'muted';
  return (
    <Badge variant={variant} size="xs" className="capitalize">
      {outcome}
      {status != null ? ` · ${status}` : ''}
    </Badge>
  );
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <code className="border-border bg-background text-foreground block rounded-md border px-2.5 py-2 font-mono text-xs break-all">
        {value}
      </code>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-muted-foreground text-[11px] font-medium">{label}</p>
      <p className="text-foreground truncate font-mono text-xs" title={value ?? undefined}>
        {value ?? '—'}
      </p>
    </div>
  );
}

function JsonPane({ label, data }: { label: string; data: unknown }) {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <pre className="border-border bg-background text-foreground max-h-56 overflow-auto rounded-md border px-2.5 py-2 font-mono text-xs leading-relaxed">
        {data === null ? 'None' : JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}
