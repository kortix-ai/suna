'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Hint from '@/components/ui/hint';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import {
  sidebarOpenerLabel,
  useShowPageSidebarOpener,
} from '@/features/workspace/workspace-layout/sidebar-opener';
import { RenameSessionModal } from '@/features/workspace/workspace-sidebar/modal/rename-session-modal';
import { SessionDeleteModal } from '@/features/workspace/workspace-sidebar/modal/session-delete-modal';
import { ShareSessionModal } from '@/features/workspace/workspace-sidebar/modal/share-session-modal';
import {
  groupSessions,
  type SessionSection,
} from '@/features/workspace/workspace-sidebar/session-grouping';
import {
  sessionLastActivityAt,
  shouldPollWorkspaceSessions,
} from '@/features/workspace/workspace-sidebar/workspace-session-list-helpers';
import { useIsCreatingWorkspaceSession } from '@/hooks/workspaces/new-session-guard';
import { useNewWorkspaceSession } from '@/hooks/workspaces/use-new-workspace-session';
import { cn } from '@/lib/utils';
import {
  selectCollapsedSections,
  selectGroupMode,
  selectHiddenSections,
  selectOrderMode,
  selectSourceFilters,
  selectStatusFilters,
  useSessionFilterStore,
} from '@/stores/session-filter-store';
import {
  deleteWorkspaceSession,
  listWorkspaceSessions,
  restartWorkspaceSession,
  stopWorkspaceSession,
  type WorkspaceSession,
} from '@kortix/sdk';
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';
import {
  CaretRightIcon,
  ChatIcon,
  MagnifyingGlassIcon,
  SidebarSimpleIcon as PanelLeft,
  PlusIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { useCallback, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';

import { SessionDetail } from './session-detail';
import { SessionRow, type SessionRowActions } from './session-row';
import { SessionsSelectionBar } from './sessions-selection-bar';
import { SessionsToolbar } from './sessions-toolbar';
import {
  buildSessionSearchIndex,
  filterWorkspaceSessions,
  mapWithConcurrency,
  pruneSelection,
  sessionIsDeletable,
  summarizeBulkDelete,
  toggleSelection,
} from './workspace-sessions-helpers';

/**
 * This page's view state is its OWN — narrowing the full inventory here must not
 * narrow the sidebar you navigate with. It still OPENS matching the sidebar:
 * a surface with no stored choice inherits the sidebar's, and only diverges once
 * you change something here.
 *
 * One exception, deliberately: COLLAPSED SECTIONS are not inherited, so every
 * section here starts expanded regardless of what is folded in the sidebar. You
 * navigate to this page to see everything. See `selectCollapsedSections`.
 */
const SURFACE = 'page' as const;

/** Concurrent DELETEs during a bulk removal. There is no bulk endpoint, so a
 *  27-session batch would otherwise open 27 sockets at once. */
const DELETE_CONCURRENCY = 4;

/** Shared fallback so a row with no formatted stamp still gets a stable prop
 *  identity — an inline `{ relative: '', exact: '' }` is a new object per
 *  render and would defeat SessionRow's memo. */
const NO_TIMESTAMP = { relative: '', exact: '' } as const;

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

// Staggered (unique) widths so the block reads as a list of rows rather than a
// solid bar; each width doubles as a stable key, which an array index is not.
// Same device as the sidebar's session skeleton.
const SKELETON_ROW_WIDTHS = ['w-56', 'w-40', 'w-64', 'w-44', 'w-72', 'w-36', 'w-52', 'w-48'];

/**
 * Shape-matched to `SessionRow`: the same `bg-popover` bordered row at the same
 * `px-3 py-2`, a `size-8 rounded-sm` status tile, the title, and the fixed `w-10`
 * slot that holds relative time. Matching the real geometry is what stops the
 * list jumping when data lands.
 *
 * `py-0` on every `Skeleton` is load-bearing: the primitive's base is
 * `rounded-md py-4`, and with `box-sizing: border-box` that 32px of padding
 * beats any smaller explicit height — so the previous `size-4` tile rendered as
 * a 16×32 bar and each `h-3.5` line as a 32px slab, none of which matched a row.
 */
function SessionListSkeleton() {
  return (
    <div className="space-y-2 pt-4" aria-hidden>
      {SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="bg-popover flex items-center gap-3 rounded-md border px-3 py-2">
          <Skeleton className="size-8 shrink-0 rounded-sm py-0" />
          <Skeleton className={cn('h-3.5 py-0', width)} />
          <Skeleton className="ml-auto h-3 w-10 shrink-0 py-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * One grouped section of the list — the page's counterpart to the sidebar's
 * `SessionListSection`, and it follows the same two rules.
 *
 * `showHeaders` false (at most one section is populated, see `groupSessions`)
 * renders the plain list: one header divides nothing. Otherwise the section is
 * a `Disclosure` whose `open` mirrors the store's collapsed list — collapsed is
 * NOT open — so the header toggle and the menu's `Collapse all` agree.
 *
 * No per-section `⋯` here, unlike the sidebar: the page's toolbar menu sits a
 * few pixels away and is the same menu, so a copy on every section header would
 * be pure duplication on a surface this wide.
 */
function SessionsSection({
  section,
  showHeader,
  open,
  onOpenChange,
  children,
}: {
  section: SessionSection;
  showHeader: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  if (!showHeader) return <div className="space-y-2">{children}</div>;

  return (
    <Disclosure
      open={open}
      onOpenChange={onOpenChange}
      className="group/section space-y-2"
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <DisclosureTrigger>
        <div className="group/section-header text-muted-foreground flex h-8 cursor-pointer items-center gap-1.5 px-1 text-sm font-medium">
          <span className="truncate">{section.label}</span>
          <span className="text-muted-foreground/60 text-xs tabular-nums">
            {section.sessions.length}
          </span>
          <CaretRightIcon
            aria-hidden
            className="size-3 shrink-0 opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/section-header:opacity-100 group-data-[state=open]/section:rotate-90"
          />
        </div>
      </DisclosureTrigger>
      <DisclosureContent contentClassName="space-y-2">{children}</DisclosureContent>
    </Disclosure>
  );
}

/**
 * Absolute top-left opener — same rules as workspace-home / session header.
 * Inlined here (not via CustomizeSectionWrapper) so this page can own spacing
 * and layout without the shared shell's constraints.
 */
function SessionsSidebarToggle() {
  const sidebar = useOptionalSidebar();
  // Shared gate — see sidebar-opener.ts. Must be called before the early
  // return, and it already covers the `!sidebar` case.
  const show = useShowPageSidebarOpener();
  if (!sidebar || !show) return null;

  const label = sidebarOpenerLabel(sidebar);

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

export function WorkspaceSessionsView({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [sessionToRename, setSessionToRename] = useState<{ id: string; name: string } | null>(null);
  const [sessionToShare, setSessionToShare] = useState<WorkspaceSession | null>(null);
  const [sessionToDelete, setSessionToDelete] = useState<{ id: string; label: string } | null>(
    null,
  );
  const newSession = useNewWorkspaceSession(workspaceId);
  const creatingSession = useIsCreatingWorkspaceSession(workspaceId);

  const sessionsQuery = useQuery({
    // 'workspace' scope: the manager-only, unfiltered full inventory — a
    // DIFFERENT server request than the default 'visible' scope every other
    // reader uses, so it MUST carry its own scope segment in the key (see
    // qk.workspace.sessions' doc comment). Sharing the default-scope key here
    // is the exact bug this file existed to fix.
    queryKey: qk.workspace.sessions(workspaceId, 'workspace'),
    queryFn: () => listWorkspaceSessions(workspaceId, { scope: 'workspace' }),
    refetchInterval: (query) =>
      shouldPollWorkspaceSessions(query.state.data as WorkspaceSession[] | undefined)
        ? 5_000
        : false,
    // The poll stops once every session settles, so without this a session
    // deleted from another surface would linger here indefinitely.
    refetchOnWindowFocus: true,
    ...contract('inventory'),
  });

  const invalidateSessions = useCallback(() => {
    // The PREFIX, not the scoped read key: this view reads the 'workspace'
    // scope, but every other surface (sidebar, header, palette, ...) reads
    // the default 'visible' scope. A rename/share/delete here has to reach
    // BOTH, or the other scope goes stale — see qk.workspace.sessionsScope.
    queryClient.invalidateQueries({ queryKey: qk.workspace.sessionsScope(workspaceId) });
  }, [workspaceId, queryClient]);

  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  // Typing stays on the fast path: the input updates from `search` every
  // keystroke, while the list below re-filters from the deferred copy. On a
  // large inventory React can drop an intermediate filter pass entirely rather
  // than run one per character.
  const deferredSearch = useDeferredValue(search);

  // Built once per session list, not once per keystroke — see
  // `buildSessionSearchIndex`.
  const searchIndex = useMemo(() => buildSessionSearchIndex(sessions), [sessions]);

  // Grouping, ordering, the two multi-select facets, hidden and collapsed
  // sections all come from the SAME per-workspace store the sidebar writes, via
  // the SAME `SessionFilterMenu`. Choose "Group by status" in either surface and
  // both show it.
  const groupMode = useSessionFilterStore(selectGroupMode(workspaceId, SURFACE));
  const orderMode = useSessionFilterStore(selectOrderMode(workspaceId, SURFACE));
  const statusFilters = useSessionFilterStore(selectStatusFilters(workspaceId, SURFACE));
  const sourceFilters = useSessionFilterStore(selectSourceFilters(workspaceId, SURFACE));
  const hiddenSections = useSessionFilterStore(selectHiddenSections(workspaceId, SURFACE));
  const collapsedSections = useSessionFilterStore(selectCollapsedSections(workspaceId, SURFACE));
  const toggleSectionCollapsed = useSessionFilterStore((s) => s.toggleSectionCollapsed);
  const resetFilters = useSessionFilterStore((s) => s.resetFilters);

  // Review Center feeds `status` grouping's `needs-you` section and the menu's
  // Show list. Same flag gate as the sidebar: flag off, query never runs.
  const reviewEnabled = useFeatureFlag(workspaceId, 'review_center').enabled;
  const reviewSummary = useReviewSessionSummary(workspaceId, { enabled: reviewEnabled });

  const visibleSessions = useMemo(
    () =>
      filterWorkspaceSessions(sessions, statusFilters, sourceFilters, deferredSearch, searchIndex),
    [sessions, statusFilters, sourceFilters, deferredSearch, searchIndex],
  );

  const grouped = useMemo(
    () =>
      groupSessions(visibleSessions, {
        mode: groupMode,
        order: orderMode,
        reviewCountBySession: reviewSummary.needsYouBySession,
        hiddenSections,
      }),
    [visibleSessions, groupMode, orderMode, reviewSummary.needsYouBySession, hiddenSections],
  );

  // Keyed on `sessions` alone, deliberately NOT on the search query: this is
  // two `date-fns` calls per session, and re-deriving it per keystroke would
  // also hand every surviving row a brand-new `time` object and re-render the
  // whole list past the memo on SessionRow.
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
  //
  // DERIVED, not synced. This used to be a `useEffect` calling `setSelected`,
  // which fires a second render pass every time `visibleSessions` changes —
  // i.e. on every keystroke while a selection is live. `pruneSelection` returns
  // the SAME Set when nothing was dropped, so this stays referentially stable
  // and every read below sees a value that is already correct for this render.
  const visibleSelection = useMemo(
    () => (selected.size === 0 ? selected : pruneSelection(selected, visibleSessions)),
    [selected, visibleSessions],
  );

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
      restartWorkspaceSession(workspaceId, sessionId),
    onSuccess: (_data, { label }) => {
      successToast(`Restarting "${label}"…`);
      invalidateSessions();
    },
    onError: (error) =>
      errorToast(error instanceof Error ? error.message : 'Failed to restart session'),
  });

  const stopMutation = useMutation({
    mutationFn: ({ sessionId }: { sessionId: string; label: string }) =>
      stopWorkspaceSession(workspaceId, sessionId),
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
            await deleteWorkspaceSession(workspaceId, sessionId);
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

  // Depends on the two `mutate` functions, not on the mutation objects.
  // `useMutation` returns a NEW object every render (isPending, variables and
  // friends all live on it), so the old deps rebuilt `rowActions` on every
  // render and pushed a fresh `actions` prop into every row. `mutate` itself is
  // referentially stable in react-query v5, which is what makes this hold.
  const restart = restartMutation.mutate;
  const stop = stopMutation.mutate;
  const rowActions: SessionRowActions = useMemo(
    () => ({
      onRename: (id, name) => setSessionToRename({ id, name }),
      onShare: setSessionToShare,
      onDelete: (id, label) => setSessionToDelete({ id, label }),
      onRestart: (sessionId, label) => restart({ sessionId, label }),
      onStop: (sessionId, label) => stop({ sessionId, label }),
    }),
    [restart, stop],
  );

  // One callback shared by every row, rather than a closure per row per render.
  const handleToggleOpen = useCallback((sessionId: string, open: boolean) => {
    setExpanded(open ? sessionId : null);
  }, []);
  const handleToggleSelect = useCallback((sessionId: string) => {
    setSelected((current) => toggleSelection(current, sessionId));
  }, []);

  const allSelected =
    selectableSessions.length > 0 && visibleSelection.size === selectableSessions.length;

  const header = selectMode ? (
    <SessionsSelectionBar
      selectedCount={visibleSelection.size}
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
      workspaceId={workspaceId}
      sessions={sessions}
      reviewCountBySession={reviewSummary.needsYouBySession}
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
              icon={ChatIcon}
              title="No sessions yet"
              description="Start a session to give this workspace its first task."
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
          ) : grouped.sections.length === 0 ? (
            // Covers BOTH "the filters/search match nothing" and "every section
            // was hidden via the menu's Show list" — `visibleSessions.length`
            // alone cannot see the second, and the list would otherwise render
            // an empty scroll area with no explanation.
            <EmptyState
              size="sm"
              icon={MagnifyingGlassIcon}
              title="No matching sessions"
              description={
                visibleSessions.length > 0
                  ? 'Every section is hidden. Re-enable one from Show in the view menu.'
                  : 'Try another search or clear the current filter.'
              }
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    resetFilters(workspaceId, SURFACE);
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
                  <div className="space-y-4 pb-6" aria-live="polite">
                    {grouped.sections.map((section) => (
                      <SessionsSection
                        key={section.id}
                        section={section}
                        showHeader={grouped.showHeaders}
                        open={!collapsedSections.includes(section.id)}
                        onOpenChange={() =>
                          toggleSectionCollapsed(workspaceId, section.id, SURFACE)
                        }
                      >
                        {section.sessions.map((session) => {
                          const time = timestamps.get(session.session_id) ?? NO_TIMESTAMP;
                          const isOpen = expanded === session.session_id;
                          return (
                            <SessionRow
                              key={session.session_id}
                              session={session}
                              time={time}
                              open={isOpen}
                              onToggleOpen={handleToggleOpen}
                              selectMode={selectMode}
                              selected={visibleSelection.has(session.session_id)}
                              onToggleSelect={handleToggleSelect}
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
                                  workspaceId={workspaceId}
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
                      </SessionsSection>
                    ))}
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
        title={`Delete ${visibleSelection.size} ${visibleSelection.size === 1 ? 'session' : 'sessions'}?`}
        description="This permanently destroys each session's branch and sandbox. It cannot be undone."
        confirmLabel={`Delete ${visibleSelection.size}`}
        confirmVariant="destructive"
        isPending={bulkDeleteMutation.isPending}
        onConfirm={() => bulkDeleteMutation.mutate([...visibleSelection])}
      />

      <ShareSessionModal
        workspaceId={workspaceId}
        session={sessionToShare}
        open={!!sessionToShare}
        onOpenChange={(open) => !open && setSessionToShare(null)}
        onSaved={invalidateSessions}
      />
      <RenameSessionModal
        workspaceId={workspaceId}
        sessionId={sessionToRename?.id ?? null}
        currentName={sessionToRename?.name}
        open={!!sessionToRename}
        onOpenChange={(open) => !open && setSessionToRename(null)}
      />
      <SessionDeleteModal
        workspaceId={workspaceId}
        sessionId={sessionToDelete?.id ?? null}
        sessionLabel={sessionToDelete?.label}
        open={!!sessionToDelete}
        onOpenChange={(open) => !open && setSessionToDelete(null)}
        // The modal's own onSuccess already invalidates qk.workspace.sessionsScope
        // — the prefix that reaches the 'workspace'-scoped key this view reads
        // — so this is a harmless duplicate, kept so the two do not silently
        // diverge again if either is edited independently.
        onDeleted={invalidateSessions}
      />
    </>
  );
}
