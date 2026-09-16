'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { RenameSessionModal } from '@/features/workspace/project-sidebar/modal/rename-session-modal';
import { SessionDeleteModal } from '@/features/workspace/project-sidebar/modal/session-delete-modal';
import { ShareSessionModal } from '@/features/workspace/project-sidebar/modal/share-session-modal';
import {
  projectSessionsRefetchInterval,
  sessionLastActivityAt,
} from '@/features/workspace/project-sidebar/project-session-list-helpers';
import {
  groupSessions,
  type SessionSection,
} from '@/features/workspace/project-sidebar/session-grouping';
import { useIsCreatingProjectSession } from '@/hooks/projects/new-session-guard';
import { useTranslations } from '@/i18n/use-translations';
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
  deleteProjectSession,
  restartProjectSession,
  stopProjectSession,
  type ProjectSession,
} from '@kortix/sdk';
import { qk, useProjectSessionPages } from '@kortix/sdk/react';
import { CaretRightIcon, ChatIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import Link from 'next/link';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildSessionSearchIndex,
  filterProjectSessions,
  mapWithConcurrency,
  pruneSelection,
  sessionIsDeletable,
  summarizeBulkDelete,
  toggleSelection,
} from './project-sessions-helpers';
import { SessionDetail } from './session-detail';
import {
  buildSessionsPageRows,
  estimateSessionsPageRowHeight,
  type SessionsPageRow,
  type SessionsPageRowGap,
} from './session-page-rows';
import { SessionRow, type SessionRowActions } from './session-row';
import { SessionsSelectionBar } from './sessions-selection-bar';
import { SessionsToolbar } from './sessions-toolbar';

/**
 * This page's view state is its OWN — narrowing the manager inventory here must not
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

/** Skeleton rows under the loaded list while the next page loads. */
const LOAD_MORE_SKELETON_ROWS = 6;

/** Rows mounted beyond each edge of the viewport, so a fast scroll back up
 *  lands on painted rows. */
const VIRTUAL_OVERSCAN_ROWS = 12;

/** Start the next page this many rows before the end of the loaded list. */
const LOAD_AHEAD_ROWS = 15;

/** `pt-4` and `pb-24` of the list, in px at `--spacing: 0.23rem`. The list is
 *  positioned by the virtualizer, so its padding is the virtualizer's. `pb-24`
 *  keeps the last row and the load-more skeleton well clear of the scroll
 *  area's `h-10` bottom fade. */
const LIST_PADDING_START_PX = 14.72;
const LIST_PADDING_END_PX = 88.32;

const ROW_GAP_CLASS: Record<SessionsPageRowGap, string> = { none: '', '2': 'pb-2', '4': 'pb-4' };

/** Timestamps per session object, formatted when a row first renders. The
 *  cache entry dies with the object, so a refetched row is formatted afresh. */
const activityTimestampBySession = new WeakMap<ProjectSession, { relative: string; exact: string }>();
function activityTimestamp(session: ProjectSession) {
  let time = activityTimestampBySession.get(session);
  if (!time) {
    time = formatTimestamp(sessionLastActivityAt(session));
    activityTimestampBySession.set(session, time);
  }
  return time;
}

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
function SessionListSkeleton({
  rows = SKELETON_ROW_WIDTHS.length,
  className,
}: {
  /** Rows to draw, 1–8. The initial load draws all eight. */
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {SKELETON_ROW_WIDTHS.slice(0, rows).map((width) => (
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
 * A section header row — the page's counterpart to the sidebar's
 * `SessionSectionHeaderRow`. It toggles the section; `open` mirrors the store's
 * collapsed list, so the header and the menu's `Collapse all` agree. The rows
 * below it are separate virtual rows; a closed section has none.
 *
 * No per-section `⋯` here, unlike the sidebar: the page's toolbar menu sits a
 * few pixels away and is the same menu.
 */
function SessionsSectionHeader({
  section,
  open,
  onToggle,
}: {
  section: SessionSection;
  open: boolean;
  onToggle: (sectionId: string) => void;
}) {
  return (
    <div className="group/section" data-state={open ? 'open' : 'closed'}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => onToggle(section.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle(section.id);
          }
        }}
        className="group/section-header text-muted-foreground flex h-8 cursor-pointer items-center gap-1.5 px-1 text-sm font-medium select-none"
      >
        <span className="truncate">{section.label}</span>
        <span className="text-muted-foreground/60 text-xs tabular-nums">
          {section.sessions.length}
        </span>
        <CaretRightIcon
          aria-hidden
          className="size-3 shrink-0 opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/section-header:opacity-100 group-data-[state=open]/section:rotate-90"
        />
      </div>
    </div>
  );
}

interface SessionsPageRowContext {
  projectId: string;
  expandedSessionId: string | null;
  selectMode: boolean;
  selection: ReadonlySet<string>;
  restartingSessionId: string | null;
  stoppingSessionId: string | null;
  actions: SessionRowActions;
  onToggleOpen: (sessionId: string, open: boolean) => void;
  onToggleSelect: (sessionId: string) => void;
  onToggleSection: (sectionId: string) => void;
  loadMoreFailed: boolean;
  onRetryLoadMore: () => void;
}

/** The virtualized list in its own component: the virtualizer re-renders its
 *  host on every scroll frame, and this keeps that to the list and the rows
 *  entering the viewport instead of the whole page. */
function SessionsVirtualList({
  rows,
  context,
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError,
  fetchNextPage,
}: {
  rows: SessionsPageRow[];
  context: SessionsPageRowContext;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => unknown;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Only rows in and near the viewport are mounted; see the sidebar list.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateSessionsPageRowHeight(rows[index]!, LOAD_MORE_SKELETON_ROWS),
    getItemKey: (index) => rows[index]!.key,
    overscan: VIRTUAL_OVERSCAN_ROWS,
    paddingStart: LIST_PADDING_START_PX,
    paddingEnd: LIST_PADDING_END_PX,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastRenderedIndex = virtualItems.at(-1)?.index ?? -1;

  // TanStack's infinite-scroll trigger. With search or filters matching no
  // loaded session the list is only its foot row, so loading continues until a
  // match appears or the pages end.
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage || isFetchNextPageError) return;
    if (lastRenderedIndex < rows.length - 1 - LOAD_AHEAD_ROWS) return;
    void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, lastRenderedIndex, rows.length, fetchNextPage]);

  return (
    <FadedScrollArea ref={scrollRef} fadeColor="from-background">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }} aria-live="polite">
        {virtualItems.map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <SessionsPageRowItem row={rows[item.index]!} context={context} />
          </div>
        ))}
      </div>
    </FadedScrollArea>
  );
}

/** One flat row, memoized against its row and the shared row context. */
const SessionsPageRowItem = memo(function SessionsPageRowItem({
  row,
  context,
}: {
  row: SessionsPageRow;
  context: SessionsPageRowContext;
}) {
  const tSidebar = useTranslations('sidebar');
  if (row.kind === 'header') {
    return (
      <div className={ROW_GAP_CLASS[row.gap]}>
        <SessionsSectionHeader
          section={row.section}
          open={row.open}
          onToggle={context.onToggleSection}
        />
      </div>
    );
  }
  if (row.kind === 'foot') {
    return context.loadMoreFailed ? (
      <div className="flex items-center gap-2 px-2">
        <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {tSidebar('sessionList.loadMoreError')}
        </p>
        <Button variant="outline" size="sm" onClick={context.onRetryLoadMore}>
          {tSidebar('retry')}
        </Button>
      </div>
    ) : (
      <div role="status">
        <span className="sr-only">{tSidebar('sessionList.loadingMore')}</span>
        <SessionListSkeleton rows={LOAD_MORE_SKELETON_ROWS} />
      </div>
    );
  }
  const session = row.session;
  const time = activityTimestamp(session);
  const isOpen = context.expandedSessionId === session.session_id;
  return (
    <div className={ROW_GAP_CLASS[row.gap]}>
      <SessionRow
        session={session}
        time={time}
        open={isOpen}
        onToggleOpen={context.onToggleOpen}
        selectMode={context.selectMode}
        selected={context.selection.has(session.session_id)}
        onToggleSelect={context.onToggleSelect}
        restarting={context.restartingSessionId === session.session_id}
        stopping={context.stoppingSessionId === session.session_id}
        actions={context.actions}
      >
        {/* Mounted only while expanded. */}
        {isOpen ? (
          <SessionDetail
            projectId={context.projectId}
            session={session}
            formatted={{
              created: formatTimestamp(session.created_at).exact,
              updated: time.exact,
              deleted: session.deleted_at ? formatTimestamp(session.deleted_at).exact : null,
            }}
          />
        ) : null}
      </SessionRow>
    </div>
  );
});

export function ProjectSessionsView({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
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
  const creatingSession = useIsCreatingProjectSession(projectId);

  const tSidebar = useTranslations('sidebar');
  // The SAME query the project sidebar reads (visible scope, same key), so the
  // pages it has already loaded show here with no request, and paging either
  // surface extends both. The sidebar is mounted on this route and owns the
  // poll; a second interval here would double it. Focus refetches dedupe.
  const sessionsQuery = useProjectSessionPages(projectId, { refetchOnWindowFocus: true });
  const { hasNextPage, fetchNextPage, isFetchingNextPage, isFetchNextPageError } = sessionsQuery;

  const invalidateSessions = useCallback(() => {
    // The PREFIX, not the scoped read key: this view reads the 'project'
    // scope, but every other surface (sidebar, header, palette, ...) reads
    // the default 'visible' scope. A rename/share/delete here has to reach
    // BOTH, or the other scope goes stale — see qk.project.sessionsScope.
    queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
  }, [projectId, queryClient]);

  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  // Typing stays on the fast path: the input updates from `search` every
  // keystroke, while the list below re-filters from the deferred copy. On a
  // large inventory React can drop an intermediate filter pass entirely rather
  // than run one per character.
  const deferredSearch = useDeferredValue(search);

  // Built only while a search is active: every loaded page changes `sessions`,
  // and indexing 12,000 sessions per page load was the list's largest cost.
  const searching = deferredSearch.trim().length > 0;
  const searchIndex = useMemo(
    () => (searching ? buildSessionSearchIndex(sessions, tI18nComplete) : undefined),
    [searching, sessions, tI18nComplete],
  );

  // Grouping, ordering, the two multi-select facets, hidden and collapsed
  // sections all come from the SAME per-project store the sidebar writes, via
  // the SAME `SessionFilterMenu`. Choose "Group by status" in either surface and
  // both show it.
  const groupMode = useSessionFilterStore(selectGroupMode(projectId, SURFACE));
  const orderMode = useSessionFilterStore(selectOrderMode(projectId, SURFACE));
  const statusFilters = useSessionFilterStore(selectStatusFilters(projectId, SURFACE));
  const sourceFilters = useSessionFilterStore(selectSourceFilters(projectId, SURFACE));
  const hiddenSections = useSessionFilterStore(selectHiddenSections(projectId, SURFACE));
  const collapsedSections = useSessionFilterStore(selectCollapsedSections(projectId, SURFACE));
  const collapsedSectionSet = useMemo(() => new Set(collapsedSections), [collapsedSections]);
  const toggleSectionCollapsed = useSessionFilterStore((s) => s.toggleSectionCollapsed);
  const resetFilters = useSessionFilterStore((s) => s.resetFilters);

  // Review Center feeds `status` grouping's `needs-you` section and the menu's
  // Show list — the same inbox summary the sidebar reads.
  const reviewSummary = useReviewSessionSummary(projectId);

  const visibleSessions = useMemo(
    () =>
      filterProjectSessions(
        sessions,
        statusFilters,
        sourceFilters,
        deferredSearch,
        tI18nComplete,
        searchIndex,
      ),
    [sessions, statusFilters, sourceFilters, deferredSearch, tI18nComplete, searchIndex],
  );

  const grouped = useMemo(
    () =>
      groupSessions(
        visibleSessions,
        {
          mode: groupMode,
          order: orderMode,
          reviewCountBySession: reviewSummary.needsYouBySession,
          hiddenSections,
        },
        tI18nComplete,
      ),
    [
      visibleSessions,
      groupMode,
      orderMode,
      reviewSummary.needsYouBySession,
      hiddenSections,
      tI18nComplete,
    ],
  );

  const pageRows = useMemo(
    () =>
      buildSessionsPageRows({
        sections: grouped.sections,
        showHeaders: grouped.showHeaders,
        collapsedSectionIds: collapsedSectionSet,
        hasNextPage: Boolean(hasNextPage),
      }),
    [grouped, collapsedSectionSet, hasNextPage],
  );

  const toggleSection = useCallback(
    (sectionId: string) => toggleSectionCollapsed(projectId, sectionId, SURFACE),
    [projectId, toggleSectionCollapsed],
  );

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
      restartProjectSession(projectId, sessionId),
    onSuccess: (_data, { label }) => {
      successToast(tI18nComplete('textdd465809683b', { value0: label }));
      invalidateSessions();
    },
    onError: (error) =>
      errorToast(error instanceof Error ? error.message : tI18nComplete.raw('text1604d2906a45')),
  });

  const stopMutation = useMutation({
    mutationFn: ({ sessionId }: { sessionId: string; label: string }) =>
      stopProjectSession(projectId, sessionId),
    onSuccess: (_data, { label }) => {
      successToast(tI18nComplete('textb86777c5ad5c', { value0: label }));
      invalidateSessions();
    },
    onError: (error) =>
      errorToast(error instanceof Error ? error.message : tI18nComplete.raw('texte0e30badc30c')),
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
      return summarizeBulkDelete(results, tI18nComplete);
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
      errorToast(error instanceof Error ? error.message : tI18nComplete.raw('text928228f0f221'));
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
      projectId={projectId}
      sessions={sessions}
      reviewCountBySession={reviewSummary.needsYouBySession}
      search={search}
      onSearchChange={setSearch}
      searchOpen={searchOpen}
      onSearchOpenChange={setSearchOpen}
      onEnterSelectMode={() => setSelectMode(true)}
      creatingSession={creatingSession}
      canSelect={sessions.length > 0}
    />
  );

  const restartingSessionId = restartMutation.isPending
    ? (restartMutation.variables?.sessionId ?? null)
    : null;
  const stoppingSessionId = stopMutation.isPending ? (stopMutation.variables?.sessionId ?? null) : null;

  // Everything a row reads besides its own session, as one memoized value.
  // Rows are memoized against it, so scrolling re-renders only rows entering
  // the viewport.
  const rowContext = useMemo<SessionsPageRowContext>(
    () => ({
      projectId,
      expandedSessionId: expanded,
      selectMode,
      selection: visibleSelection,
      restartingSessionId,
      stoppingSessionId,
      actions: rowActions,
      onToggleOpen: handleToggleOpen,
      onToggleSelect: handleToggleSelect,
      onToggleSection: toggleSection,
      loadMoreFailed: isFetchNextPageError,
      onRetryLoadMore: () => void fetchNextPage(),
    }),
    [
      projectId,
      expanded,
      selectMode,
      visibleSelection,
      restartingSessionId,
      stoppingSessionId,
      rowActions,
      handleToggleOpen,
      handleToggleSelect,
      toggleSection,
      isFetchNextPageError,
      fetchNextPage,
    ],
  );

  return (
    <>
      {/* Fixed shell: the header is a non-scrolling band and the list below it
          owns the only scroll container on the page. `overflow-hidden` here
          stops the app shell from scrolling when the list grows. */}
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
        <SidebarToggle placement="floating" />
        <header
          className={cn(
            'mx-auto w-full max-w-4xl shrink-0 px-4 pt-10 pb-5 lg:pt-20',
            'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between',
          )}
        >
          <div className="space-y-1">
            <h2 className="text-foreground text-xl font-medium">
              {tI18nComplete.raw('text6fa3cbf451b2')}
            </h2>
          </div>
          <div className="mt-2 shrink-0 sm:mt-0">{header}</div>
        </header>

        <div className={cn('mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-4 pb-4')}>
          {sessionsQuery.isLoading ? (
            <SessionListSkeleton className="pt-4" />
          ) : sessionsQuery.isError && !sessionsQuery.data ? (
            <ErrorState
              size="sm"
              title={tI18nComplete.raw('textb6d85433a7ee')}
              description={
                sessionsQuery.error instanceof Error ? sessionsQuery.error.message : undefined
              }
              action={
                <Button variant="outline" size="sm" onClick={() => sessionsQuery.refetch()}>
                  {tI18nComplete.raw('text942087cc2d41')}
                </Button>
              }
            />
          ) : sessions.length === 0 && !hasNextPage ? (
            <EmptyState
              size="sm"
              icon={ChatIcon}
              title={tI18nComplete.raw('textf502267deff4')}
              description={tI18nComplete.raw('text93e404732659')}
              action={
                // The composer route is known at render time, so this is an
                // anchor whose payload Next already holds — the first control a
                // brand-new project offers must not run a cold RSC fetch.
                creatingSession ? (
                  <Button variant="outline" size="sm" className="gap-1.5" disabled aria-busy>
                    <PlusIcon className="size-3.5 shrink-0" />
                    {tI18nComplete.raw('textcffdba22adf2')}
                  </Button>
                ) : (
                  <Button asChild variant="outline" size="sm" className="gap-1.5">
                    <Link href={`/projects/${projectId}`} prefetch>
                      <PlusIcon className="size-3.5 shrink-0" />
                      {tI18nComplete.raw('textcffdba22adf2')}
                    </Link>
                  </Button>
                )
              }
            />
          ) : grouped.sections.length === 0 && !hasNextPage ? (
            // Covers BOTH "the filters/search match nothing" and "every section
            // was hidden via the menu's Show list" — `visibleSessions.length`
            // alone cannot see the second, and the list would otherwise render
            // an empty scroll area with no explanation.
            <EmptyState
              size="sm"
              icon={MagnifyingGlassIcon}
              title={tI18nComplete.raw('text2732406e3be5')}
              description={
                visibleSessions.length > 0
                  ? tI18nComplete.raw('text67f2187d81d7')
                  : tI18nComplete.raw('text2749b54ef956')
              }
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    resetFilters(projectId, SURFACE);
                    setSearch('');
                  }}
                >
                  {tI18nComplete.raw('text7179ea0035fc')}
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
                <SessionsVirtualList
                  rows={pageRows}
                  context={rowContext}
                  hasNextPage={Boolean(hasNextPage)}
                  isFetchingNextPage={isFetchingNextPage}
                  isFetchNextPageError={isFetchNextPageError}
                  fetchNextPage={fetchNextPage}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={bulkConfirmOpen}
        onOpenChange={(open) => !bulkDeleteMutation.isPending && setBulkConfirmOpen(open)}
        title={tI18nComplete('text7ed6733a3900', {
          value0: visibleSelection.size,
          value1: visibleSelection.size === 1 ? 'session' : 'sessions',
        })}
        description={tI18nComplete.raw('textac371f652a2d')}
        confirmLabel={`Delete ${visibleSelection.size}`}
        confirmVariant="destructive"
        isPending={bulkDeleteMutation.isPending}
        onConfirm={() => bulkDeleteMutation.mutate([...visibleSelection])}
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
        // The modal's own onSuccess already invalidates qk.project.sessionsScope
        // — the prefix that reaches the 'project'-scoped key this view reads
        // — so this is a harmless duplicate, kept so the two do not silently
        // diverge again if either is edited independently.
        onDeleted={invalidateSessions}
      />
    </>
  );
}
