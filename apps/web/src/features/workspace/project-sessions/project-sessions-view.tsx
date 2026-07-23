'use client';

import { sessionSource, type SessionSourceKind } from '@/components/projects/session-label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { RenameSessionModal } from '@/features/workspace/project-sidebar/modal/rename-session-modal';
import { SessionDeleteModal } from '@/features/workspace/project-sidebar/modal/session-delete-modal';
import {
  sessionVisibilityMeta,
  ShareSessionModal,
} from '@/features/workspace/project-sidebar/modal/share-session-modal';
import {
  getSessionDisplayTitle,
  shouldPollProjectSessions,
} from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { cn } from '@/lib/utils';
import {
  listProjectSessions,
  restartProjectSession,
  stopProjectSession,
  type ProjectSession,
  type ProjectSessionStatus,
} from '@kortix/sdk/projects-client';
import { Pencil, Share, TrashSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  ExternalLink,
  GitBranch,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  Square,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { IconType } from 'react-icons/lib';

import {
  filterProjectSessions,
  PROJECT_SESSIONS_FILTERS,
  projectSessionsFilterCounts,
  sessionAccessMeta,
  sessionOwnerLabel,
  type ProjectSessionsFilter,
} from './project-sessions-helpers';

const SOURCE_ICONS: Record<SessionSourceKind, LucideIcon | IconType> = {
  chat: MessageSquare,
  slack: Icon.Slack,
  telegram: Icon.Telegram,
  email: Mail,
  schedule: CalendarClock,
  webhook: Webhook,
};

const STATUS_META: Record<
  ProjectSessionStatus,
  { label: string; variant: 'success' | 'warning' | 'muted' | 'destructive' | 'kortix' }
> = {
  queued: { label: 'Queued', variant: 'warning' },
  branching: { label: 'Branching', variant: 'warning' },
  provisioning: { label: 'Provisioning', variant: 'warning' },
  running: { label: 'Running', variant: 'success' },
  completed: { label: 'Completed', variant: 'kortix' },
  stopped: { label: 'Stopped', variant: 'muted' },
  failed: { label: 'Failed', variant: 'destructive' },
};

function formatTimestamp(value: string): { relative: string; exact: string } {
  try {
    const date = new Date(value);
    return {
      relative: formatDistanceToNowStrict(date, { addSuffix: true }),
      exact: format(date, 'MMM d, yyyy, h:mm a'),
    };
  } catch {
    return { relative: 'Unknown', exact: value };
  }
}

function SessionListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3">
          <Skeleton className="size-9 shrink-0 rounded-sm" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={cn('h-3.5 rounded-sm', index % 2 ? 'w-44' : 'w-64')} />
            <Skeleton className="h-3 w-36 rounded-sm" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function DetailItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd
        className={cn(
          'text-foreground break-words text-sm',
          mono && 'font-mono text-xs tabular-nums',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function SessionRow({
  projectId,
  session,
  onRename,
  onShare,
  onDelete,
  onRestart,
  onStop,
  restarting,
  stopping,
}: {
  projectId: string;
  session: ProjectSession;
  onRename: (sessionId: string, currentName: string) => void;
  onShare: (session: ProjectSession) => void;
  onDelete: (sessionId: string, label: string) => void;
  onRestart: (sessionId: string, label: string) => void;
  onStop: (sessionId: string, label: string) => void;
  restarting: boolean;
  stopping: boolean;
}) {
  const [open, setOpen] = useState(false);
  const title = getSessionDisplayTitle(session);
  const source = sessionSource(session);
  const SourceIcon = SOURCE_ICONS[source.kind];
  const status = STATUS_META[session.status];
  const visibility = sessionVisibilityMeta(session);
  const ownerLabel = sessionOwnerLabel(session);
  const access = sessionAccessMeta(session);
  const isDeleted = Boolean(session.deleted_at);
  const canManageSharing = session.can_manage_sharing !== false && !isDeleted;
  const hasLifecycleActions = access.canOpen && !isDeleted;
  const hasActions = canManageSharing || hasLifecycleActions;
  const ownerTypeLabel =
    session.owner_type === 'user'
      ? 'Person'
      : session.owner_type === 'service_account'
        ? 'Agent / service account'
        : session.owner_type === 'unknown'
          ? 'Unknown principal'
          : 'Unattributed';
  const created = formatTimestamp(session.created_at);
  const updated = formatTimestamp(session.updated_at || session.created_at);
  const conversationCount = session.runtime_sessions.length;
  const archivedConversationCount = session.runtime_sessions.filter(
    (item) => item.archived_at,
  ).length;
  const href = `/projects/${projectId}/sessions/${session.session_id}`;

  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      variant="outline"
      className="group/session bg-popover overflow-hidden"
    >
      <DisclosureTrigger variant="outline">
        <button
          type="button"
          className="hover:bg-muted/40 flex min-h-16 w-full cursor-pointer items-center gap-3 rounded-md px-4 py-3 text-left transition-colors duration-150"
          aria-label={`${open ? 'Hide' : 'Show'} details for ${title}`}
        >
          <span className="bg-kortix-base/20 flex size-9 shrink-0 items-center justify-center rounded-sm">
            <SourceIcon className="text-foreground size-5" />
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-foreground max-w-full truncate text-sm font-medium">
                {title}
              </span>
              {isDeleted ? (
                <Badge variant="destructive" size="xs">
                  Deleted
                </Badge>
              ) : session.can_access === false ? (
                <Badge variant="outline" size="xs">
                  Metadata only
                </Badge>
              ) : session.is_owner === false ? (
                <Badge variant="kortix" size="xs">
                  Shared
                </Badge>
              ) : null}
            </span>
            <span className="text-muted-foreground mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
              <span>
                {source.triggerSlug ? `${source.label} · ${source.triggerSlug}` : source.label}
              </span>
              <span className="text-muted-foreground/40">&bull;</span>
              <span className="truncate">{ownerLabel}</span>
              <span className="text-muted-foreground/40">&bull;</span>
              <span className="tabular-nums" title={updated.exact}>
                {updated.relative}
              </span>
            </span>
          </span>

          <Badge variant={status.variant} size="sm" className="hidden sm:inline-flex">
            {status.label}
          </Badge>
          <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]/session:rotate-180" />
        </button>
      </DisclosureTrigger>

      <DisclosureContent variant="outline" contentClassName="border-border border-t">
        <div className="space-y-5 px-4 py-5">
          <div className="flex flex-wrap items-center gap-2 sm:hidden">
            <Badge variant={status.variant} size="sm">
              {status.label}
            </Badge>
            <Badge variant="outline" size="sm">
              {visibility.label}
            </Badge>
          </div>

          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            <DetailItem label="Created" value={created.exact} />
            <DetailItem label="Last activity" value={updated.exact} />
            <DetailItem label="Status" value={status.label} />
            <DetailItem label="Session / resource owner" value={ownerLabel} />
            <DetailItem label="Owner identity" value={ownerTypeLabel} />
            <DetailItem
              label="Owner ID"
              value={session.created_by || 'Unattributed'}
              mono={Boolean(session.created_by)}
            />
            <DetailItem label="Your access" value={access.label} />
            <DetailItem label="Visibility" value={visibility.label} />
            <DetailItem
              label="Source"
              value={source.triggerSlug ? `${source.label} · ${source.triggerSlug}` : source.label}
            />
            <DetailItem label="Agent" value={session.agent_name || 'Project default'} />
            <DetailItem label="Runtime" value={session.sandbox_provider || 'Not provisioned'} />
            <DetailItem
              label="Runtime resource state"
              value={session.runtime_status || 'Missing'}
            />
            <DetailItem
              label="Conversations"
              value={`${conversationCount} runtime session${conversationCount === 1 ? '' : 's'}${
                archivedConversationCount > 0 ? ` · ${archivedConversationCount} archived` : ''
              }`}
            />
            <DetailItem label="Base ref" value={session.base_ref || 'Default branch'} mono />
            <DetailItem label="Branch" value={session.branch_name || 'Not created'} mono />
            <DetailItem label="Session ID" value={session.session_id} mono />
            <DetailItem label="Sandbox ID" value={session.sandbox_id || 'Missing'} mono />
            <DetailItem
              label="Runtime conversation ID"
              value={session.runtime_session_id || session.acp_session_id || 'Not synced'}
              mono
            />
          </dl>

          {session.error ? (
            <InfoBanner tone="destructive" icon={AlertTriangle} title="Session error">
              <span className="break-words">{session.error}</span>
            </InfoBanner>
          ) : null}

          {isDeleted ? (
            <InfoBanner tone="neutral" title="Soft-deleted session">
              <span>
                Deleted{' '}
                {session.deleted_at
                  ? formatTimestamp(session.deleted_at).exact
                  : 'at an unknown time'}
                {session.deleted_by ? ` by ${session.deleted_by}` : ''}. The durable record remains
                visible here for investigation.
              </span>
            </InfoBanner>
          ) : session.can_access === false ? (
            <InfoBanner tone="neutral" title="Metadata-only access">
              You can inspect this inventory record, but the owner has not shared the session
              content with you.
            </InfoBanner>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate font-mono">
                {session.branch_name || session.session_id}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {access.canOpen ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={href}>
                    Open session
                    <ExternalLink className="size-3.5 shrink-0" />
                  </Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  {access.label}
                </Button>
              )}
              {hasActions ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="secondary" size="sm">
                      <MoreHorizontal className="size-3.5 shrink-0" />
                      Actions
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    {hasLifecycleActions ? (
                      <DropdownMenuItem onSelect={() => onRename(session.session_id, title)}>
                        <Pencil />
                        Rename
                      </DropdownMenuItem>
                    ) : null}
                    {canManageSharing ? (
                      <DropdownMenuItem onSelect={() => onShare(session)}>
                        <Share />
                        Share
                      </DropdownMenuItem>
                    ) : null}
                    {hasLifecycleActions ? (
                      <DropdownMenuItem
                        disabled={restarting}
                        onSelect={() => onRestart(session.session_id, title)}
                      >
                        {restarting ? <Loading className="size-4 shrink-0" /> : <RotateCcw />}
                        Restart
                      </DropdownMenuItem>
                    ) : null}
                    {session.status === 'running' && hasLifecycleActions ? (
                      <DropdownMenuItem
                        disabled={stopping}
                        onSelect={() => onStop(session.session_id, title)}
                      >
                        {stopping ? <Loading className="size-4 shrink-0" /> : <Square />}
                        Stop
                      </DropdownMenuItem>
                    ) : null}
                    {hasLifecycleActions ? (
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => onDelete(session.session_id, title)}
                      >
                        <TrashSolid />
                        Delete
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}

export function ProjectSessionsView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<ProjectSessionsFilter>('all');
  const [search, setSearch] = useState('');
  const [sessionToRename, setSessionToRename] = useState<{ id: string; name: string } | null>(null);
  const [sessionToShare, setSessionToShare] = useState<ProjectSession | null>(null);
  const [sessionToDelete, setSessionToDelete] = useState<{ id: string; label: string } | null>(
    null,
  );
  const newSession = useNewProjectSession(projectId);

  const sessionsQuery = useQuery({
    queryKey: ['project-session-inventory', projectId],
    queryFn: () => listProjectSessions(projectId, { scope: 'project' }),
    staleTime: 10_000,
    refetchInterval: (query) =>
      shouldPollProjectSessions(query.state.data as ProjectSession[] | undefined) ? 5_000 : false,
    refetchOnWindowFocus: false,
  });

  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const counts = useMemo(() => projectSessionsFilterCounts(sessions), [sessions]);
  const visibleSessions = useMemo(
    () => filterProjectSessions(sessions, filter, search),
    [sessions, filter, search],
  );

  const restartMutation = useMutation({
    mutationFn: ({ sessionId }: { sessionId: string; label: string }) =>
      restartProjectSession(projectId, sessionId),
    onSuccess: (_data, { label }) => {
      successToast(`Restarting "${label}"…`);
      queryClient.invalidateQueries({ queryKey: ['project-session-inventory', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
    onError: (error) =>
      errorToast(error instanceof Error ? error.message : 'Failed to restart session'),
  });

  const stopMutation = useMutation({
    mutationFn: ({ sessionId }: { sessionId: string; label: string }) =>
      stopProjectSession(projectId, sessionId),
    onSuccess: (_data, { label }) => {
      successToast(`"${label}" stopped`);
      queryClient.invalidateQueries({ queryKey: ['project-session-inventory', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
    onError: (error) =>
      errorToast(error instanceof Error ? error.message : 'Failed to stop session'),
  });

  const action = (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      className="gap-1.5"
      onClick={() => newSession()}
    >
      <Plus className="size-4 shrink-0" />
      New session
    </Button>
  );

  return (
    <CustomizeSectionWrapper
      title="Sessions"
      description="Manager inventory of every durable session and its owner, access, and runtime state."
      action={action}
      className="max-w-5xl"
    >
      <div className="space-y-4">
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <Search />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            variant="popover"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by title, owner, source, branch, agent, or ID"
            aria-label="Search sessions"
          />
          {search ? <InputGroupSearchClear onClick={() => setSearch('')} /> : null}
        </InputGroupSearch>

        <div className="overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <FilterBar className="h-8 rounded-md">
            {PROJECT_SESSIONS_FILTERS.map((option) => (
              <FilterBarItem
                key={option.value}
                className="h-[calc(100%-4px)] rounded-[calc(var(--radius)-3px)] px-2.5 text-xs"
                data-state={filter === option.value ? 'active' : 'inactive'}
                aria-selected={filter === option.value}
                onClick={() => setFilter(option.value)}
              >
                {option.label}
                <span className="tabular-nums">{counts[option.value]}</span>
              </FilterBarItem>
            ))}
          </FilterBar>
        </div>

        {sessionsQuery.isLoading ? (
          <SessionListSkeleton />
        ) : sessionsQuery.isError ? (
          <ErrorState
            size="sm"
            title="Sessions could not be loaded"
            description={
              sessionsQuery.error instanceof Error ? sessionsQuery.error.message : undefined
            }
            action={
              <Button variant="outline" size="sm" onClick={() => sessionsQuery.refetch()}>
                Retry
              </Button>
            }
          />
        ) : sessions.length === 0 ? (
          <EmptyState
            size="sm"
            icon={MessageSquare}
            title="No sessions yet"
            description="Start a session to give this project its first task."
            action={
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => newSession()}>
                <Plus className="size-3.5 shrink-0" />
                New session
              </Button>
            }
          />
        ) : visibleSessions.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Search}
            title="No matching sessions"
            description="Try another search or clear the current filter."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFilter('all');
                  setSearch('');
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <div className="space-y-2" aria-live="polite">
            <p className="text-muted-foreground text-xs tabular-nums">
              Showing {visibleSessions.length} of {sessions.length}{' '}
              {sessions.length === 1 ? 'session' : 'sessions'}
            </p>
            {visibleSessions.map((session) => (
              <SessionRow
                key={session.session_id}
                projectId={projectId}
                session={session}
                onRename={(id, name) => setSessionToRename({ id, name })}
                onShare={setSessionToShare}
                onDelete={(id, label) => setSessionToDelete({ id, label })}
                onRestart={(sessionId, label) => restartMutation.mutate({ sessionId, label })}
                onStop={(sessionId, label) => stopMutation.mutate({ sessionId, label })}
                restarting={
                  restartMutation.isPending &&
                  restartMutation.variables?.sessionId === session.session_id
                }
                stopping={
                  stopMutation.isPending && stopMutation.variables?.sessionId === session.session_id
                }
              />
            ))}
          </div>
        )}
      </div>

      <ShareSessionModal
        projectId={projectId}
        session={sessionToShare}
        open={!!sessionToShare}
        onOpenChange={(open) => !open && setSessionToShare(null)}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ['project-session-inventory', projectId] });
          queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
        }}
      />
      <RenameSessionModal
        projectId={projectId}
        sessionId={sessionToRename?.id ?? null}
        currentName={sessionToRename?.name}
        open={!!sessionToRename}
        onOpenChange={(open) => !open && setSessionToRename(null)}
      />
      <SessionDeleteModal
        projectId={projectId}
        sessionId={sessionToDelete?.id ?? null}
        sessionLabel={sessionToDelete?.label}
        open={!!sessionToDelete}
        onOpenChange={(open) => !open && setSessionToDelete(null)}
      />
    </CustomizeSectionWrapper>
  );
}
