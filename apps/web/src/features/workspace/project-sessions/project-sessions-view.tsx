'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Hint from '@/components/ui/hint';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { RenameSessionModal } from '@/features/workspace/project-sidebar/modal/rename-session-modal';
import { SessionDeleteModal } from '@/features/workspace/project-sidebar/modal/session-delete-modal';
import { ShareSessionModal } from '@/features/workspace/project-sidebar/modal/share-session-modal';
import {
  sessionLastActivityAt,
  shouldPollProjectSessions,
} from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { useIsCreatingProjectSession } from '@/hooks/projects/new-session-guard';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { cn } from '@/lib/utils';
import {
  deleteProjectSession,
  listProjectSessions,
  restartProjectSession,
  stopProjectSession,
  type ProjectSession,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  ChatIcon,
  MagnifyingGlassIcon,
  SidebarSimpleIcon as PanelLeft,
  PlusIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  availableProjectSessionsFilters,
  filterProjectSessions,
  mapWithConcurrency,
  pruneSelection,
  sessionIsDeletable,
  summarizeBulkDelete,
  toggleSelection,
  type ProjectSessionsFilter,
} from './project-sessions-helpers';
import { SessionDetail } from './session-detail';
import { SessionRow, type SessionRowActions } from './session-row';
import { SessionsSelectionBar } from './sessions-selection-bar';
import { SessionsToolbar } from './sessions-toolbar';

/** Concurrent DELETEs during a bulk removal. There is no bulk endpoint, so a
 *  27-session batch would otherwise open 27 sockets at once. */
const DELETE_CONCURRENCY = 4;

function formatTimestamp(value: string): { relative: string; exact: string } {
  try {
    const date = new Date(value);
    return {
      relative: formatDistanceToNowStrict(date, { addSuffix: false }),
      exact: format(date, 'MMM d, yyyy, h:mm a'),
    };
  } catch {
    return { relative: 'Unknown', exact: value };
  }
}

function SessionListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="bg-popover flex h-11 items-center gap-3 rounded-md border px-3">
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton className={cn('h-3.5 rounded-sm', index % 2 ? 'w-44' : 'w-64')} />
          <Skeleton className="ml-auto h-3 w-14 rounded-sm" />
        </div>
      ))}
    </div>
  );
}

/**
 * Absolute top-left opener — same rules as project-home / session header.
 * Inlined here (not via CustomizeSectionWrapper) so this page can own spacing
 * and layout without the shared shell's constraints.
 */
function SessionsSidebarToggle() {
  const sidebar = useOptionalSidebar();
  if (!sidebar) return null;
  if (!sidebar.isMobile && sidebar.state === 'expanded') return null;

  const label =
    sidebar.state === 'expanded'
      ? 'Collapse sidebar'
      : sidebar.peek
        ? 'Pin sidebar'
        : 'Open sidebar';

  return (
    <Hint label={label} side="bottom">
      <Button
        type="button"
        aria-label={label}
        variant="ghost"
        size="icon"
        onClick={sidebar.toggleSidebar}
        onPointerEnter={sidebar.state === 'collapsed' ? sidebar.peekEnter : undefined}
        onPointerLeave={sidebar.state === 'collapsed' ? sidebar.peekLeave : undefined}
        className="hover:bg-sidebar-accent hover:text-sidebar-foreground absolute top-2 left-2 z-20 shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
      >
        <PanelLeft className="cn-rtl-flip size-4" />
      </Button>
    </Hint>
  );
}

export function ProjectSessionsView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const sidebar = useOptionalSidebar();
  const showSidebarToggle = sidebar != null && (sidebar.isMobile || sidebar.state !== 'expanded');
  const [filter, setFilter] = useState<ProjectSessionsFilter>('all');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [sessionToRename, setSessionToRename] = useState<{ id: string; name: string } | null>(null);
  const [sessionToShare, setSessionToShare] = useState<ProjectSession | null>(null);
  const [sessionToDelete, setSessionToDelete] = useState<{ id: string; label: string } | null>(
    null,
  );
  const newSession = useNewProjectSession(projectId);
  const creatingSession = useIsCreatingProjectSession(projectId);

  const sessionsQuery = useQuery({
    queryKey: qk.project.sessions(projectId),
    queryFn: () => listProjectSessions(projectId, { scope: 'project' }),
    refetchInterval: (query) =>
      shouldPollProjectSessions(query.state.data as ProjectSession[] | undefined) ? 5_000 : false,
    // The poll stops once every session settles, so without this a session
    // deleted from another surface would linger here indefinitely.
    refetchOnWindowFocus: true,
    ...contract('inventory'),
  });

  const invalidateSessions = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: qk.project.sessions(projectId) });
  }, [projectId, queryClient]);

  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const visibleSessions = useMemo(
    () => filterProjectSessions(sessions, filter, search),
    [sessions, filter, search],
  );
  const filterGroups = useMemo(
    () => availableProjectSessionsFilters(sessions, filter),
    [sessions, filter],
  );
  const timestamps = useMemo(() => {
    const map = new Map<string, { relative: string; exact: string }>();
    for (const session of sessions) {
      map.set(session.session_id, formatTimestamp(sessionLastActivityAt(session)));
    }
    return map;
  }, [sessions]);

  const selectableSessions = useMemo(
    () => visibleSessions.filter(sessionIsDeletable),
    [visibleSessions],
  );

  // Selection must never outlive its own visibility: narrowing the filter after
  // selecting would otherwise leave "N selected" counting off-screen rows, and
  // "Delete N" would destroy sessions the user cannot see.
  useEffect(() => {
    setSelected((current) =>
      current.size === 0 ? current : pruneSelection(current, visibleSessions),
    );
  }, [visibleSessions]);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  useEffect(() => {
    if (!selectMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') exitSelectMode();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectMode, exitSelectMode]);

  // "/" focuses search, the way it does in the rest of the product.
  useEffect(() => {
    if (searchOpen || selectMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')
      )
        return;
      event.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [searchOpen, selectMode]);

  const restartMutation = useMutation({
    mutationFn: ({ sessionId }: { sessionId: string; label: string }) =>
      restartProjectSession(projectId, sessionId),
    onSuccess: (_data, { label }) => {
      successToast(`Restarting "${label}"…`);
      invalidateSessions();
    },
    onError: (error) =>
      errorToast(error instanceof Error ? error.message : 'Failed to restart session'),
  });

  const stopMutation = useMutation({
    mutationFn: ({ sessionId }: { sessionId: string; label: string }) =>
      stopProjectSession(projectId, sessionId),
    onSuccess: (_data, { label }) => {
      successToast(`"${label}" stopped`);
      invalidateSessions();
    },
    onError: (error) =>
      errorToast(error instanceof Error ? error.message : 'Failed to stop session'),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (sessionIds: string[]) => {
      const results = await mapWithConcurrency(
        sessionIds,
        DELETE_CONCURRENCY,
        async (sessionId) => {
          try {
            await deleteProjectSession(projectId, sessionId);
            return { sessionId, ok: true };
          } catch {
            return { sessionId, ok: false };
          }
        },
      );
      return summarizeBulkDelete(results);
    },
    onSuccess: (summary) => {
      // Partial failure is a real outcome, not an error. Reporting "Deleted 7"
      // while two rows survive is worse than reporting nothing.
      if (summary.failed.length === 0) successToast(summary.message);
      else if (summary.succeeded.length === 0) errorToast(summary.message);
      else warningToast(summary.message);

      setBulkConfirmOpen(false);
      exitSelectMode();
      invalidateSessions();
    },
    onError: (error) => {
      errorToast(error instanceof Error ? error.message : 'Failed to delete sessions');
      setBulkConfirmOpen(false);
    },
  });

  const rowActions: SessionRowActions = useMemo(
    () => ({
      onRename: (id, name) => setSessionToRename({ id, name }),
      onShare: setSessionToShare,
      onDelete: (id, label) => setSessionToDelete({ id, label }),
      onRestart: (sessionId, label) => restartMutation.mutate({ sessionId, label }),
      onStop: (sessionId, label) => stopMutation.mutate({ sessionId, label }),
    }),
    [restartMutation, stopMutation],
  );

  const allSelected = selectableSessions.length > 0 && selected.size === selectableSessions.length;

  const header = selectMode ? (
    <SessionsSelectionBar
      selectedCount={selected.size}
      selectableCount={selectableSessions.length}
      allSelected={allSelected}
      onSelectAll={() =>
        setSelected(new Set(selectableSessions.map((session) => session.session_id)))
      }
      onClearSelection={() => setSelected(new Set())}
      onExit={exitSelectMode}
      onDelete={() => setBulkConfirmOpen(true)}
      deleting={bulkDeleteMutation.isPending}
    />
  ) : (
    <SessionsToolbar
      filter={filter}
      onFilterChange={setFilter}
      groups={filterGroups}
      search={search}
      onSearchChange={setSearch}
      searchOpen={searchOpen}
      onSearchOpenChange={setSearchOpen}
      onEnterSelectMode={() => setSelectMode(true)}
      onNewSession={() => newSession()}
      creatingSession={creatingSession}
      canSelect={sessions.length > 0}
    />
  );

  return (
    <>
      {/* Fixed shell: the header is a non-scrolling band and the list below it
          owns the only scroll container on the page. `overflow-hidden` here
          stops the app shell from scrolling when the list grows. */}
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
        <SessionsSidebarToggle />
        <header
          className={cn(
            'mx-auto w-full max-w-4xl shrink-0 px-4 pt-10 pb-5 lg:pt-20',
            'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between',
          )}
        >
          <div className="space-y-1">
            <h2 className="text-foreground text-xl font-medium">Sessions</h2>
          </div>
          <div className="mt-2 shrink-0 sm:mt-0">{header}</div>
        </header>

        <div className={cn('mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-4 pb-4')}>
          {sessionsQuery.isLoading ? (
            <div className="pt-4">
              <SessionListSkeleton />
            </div>
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
              icon={ChatIcon}
              title="No sessions yet"
              description="Start a session to give this project its first task."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => newSession()}
                  disabled={creatingSession}
                  aria-busy={creatingSession}
                >
                  <PlusIcon className="size-3.5 shrink-0" />
                  New session
                </Button>
              }
            />
          ) : visibleSessions.length === 0 ? (
            <EmptyState
              size="sm"
              icon={MagnifyingGlassIcon}
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
            /* The list gets a containing block whose height cannot depend on
                   its children. `FadedScrollArea` sizes its outer element with
                   `h-full`, and `height: 100%` only resolves against a definite
                   height — inside a flex chain still being measured from content it
                   resolves to `auto`, so the component grows to fit every row and
                   the whole app shell scrolls instead of the list. An
                   `absolute inset-0` layer is out of flow, so this parent
                   contributes no content height and takes only what flexbox gives
                   it, which makes the percentage definite. */
            <div className="relative min-h-0 flex-1">
              <div className="absolute inset-0">
                <FadedScrollArea fadeColor="from-background" className="pt-4">
                  <div className="space-y-2 pb-6" aria-live="polite">
                    {visibleSessions.map((session) => {
                      const time = timestamps.get(session.session_id) ?? {
                        relative: '',
                        exact: '',
                      };
                      const isOpen = expanded === session.session_id;
                      return (
                        <SessionRow
                          key={session.session_id}
                          session={session}
                          time={time}
                          open={isOpen}
                          onOpenChange={(open) => setExpanded(open ? session.session_id : null)}
                          selectMode={selectMode}
                          selected={selected.has(session.session_id)}
                          onToggleSelect={(id) =>
                            setSelected((current) => toggleSelection(current, id))
                          }
                          restarting={
                            restartMutation.isPending &&
                            restartMutation.variables?.sessionId === session.session_id
                          }
                          stopping={
                            stopMutation.isPending &&
                            stopMutation.variables?.sessionId === session.session_id
                          }
                          actions={rowActions}
                        >
                          {/* Mounted only while expanded — 27 collapsed detail grids
                              would otherwise all format timestamps on every render. */}
                          {isOpen ? (
                            <SessionDetail
                              projectId={projectId}
                              session={session}
                              formatted={{
                                created: formatTimestamp(session.created_at).exact,
                                updated: time.exact,
                                deleted: session.deleted_at
                                  ? formatTimestamp(session.deleted_at).exact
                                  : null,
                              }}
                            />
                          ) : null}
                        </SessionRow>
                      );
                    })}
                  </div>
                </FadedScrollArea>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={bulkConfirmOpen}
        onOpenChange={(open) => !bulkDeleteMutation.isPending && setBulkConfirmOpen(open)}
        title={`Delete ${selected.size} ${selected.size === 1 ? 'session' : 'sessions'}?`}
        description="This permanently destroys each session's branch and sandbox. It cannot be undone."
        confirmLabel={`Delete ${selected.size}`}
        confirmVariant="destructive"
        isPending={bulkDeleteMutation.isPending}
        onConfirm={() => bulkDeleteMutation.mutate([...selected])}
      />

      <ShareSessionModal
        projectId={projectId}
        session={sessionToShare}
        open={!!sessionToShare}
        onOpenChange={(open) => !open && setSessionToShare(null)}
        onSaved={invalidateSessions}
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
        // The modal's own onSuccess already invalidates qk.project.sessions —
        // the SAME key this view now reads — so this is a harmless duplicate,
        // kept so the two do not silently diverge again if either is edited
        // independently.
        onDeleted={invalidateSessions}
      />
    </>
  );
}
