/**
 * ProjectSessionsPage — every session of a project, at `/projects/[id]/sessions`
 * (opened from the project drawer's Search row, `autoFocusSearch` true so the
 * field is already focused; a session row's own navigation opens it without
 * that focus).
 *
 *   header   `PageHeader` (Jay, 2026-09-22): hamburger, "Sessions" title, and
 *            a Filter action at the right — the same header every other
 *            project tool page uses.
 *   search   SearchListHeader. Server-side (`q`, debounced 250 ms) over every
 *            session the viewer may see: title, starter, session id. A parent
 *            that matched only through a child opens on that child.
 *   scope    All / Mine / Shared / Automated chips: `started_by` (KRTX-639).
 *   filter   Filter sheet (`SettingsGroup` of toggleable status rows: Needs
 *            you / Running / Stopped / Failed; Running covers starting
 *            sessions). Empty selection shows every status; toggling narrows
 *            the timeline to just the checked ones. Basic on purpose — no
 *            date range or sort, unlike web's fuller filter panel. Picked
 *            statuses show as a chip under the search field; the chip, the
 *            sheet and the no-match state share one Reset (search + statuses).
 *            Search and filter live in `useSessionFilterStore` per project, so
 *            they survive opening a session and coming back (KRTX-250).
 *   list     Today / Yesterday / This week / Older, each a group of
 *            `SettingsRow`s (the settings screens' layout); a group's title
 *            shows only when more than one group has sessions. One virtualised
 *            list item per row (`SettingsGroupItem`) and per group title
 *            (`sessionListItems`), so a long "Older" group mounts only what
 *            is on screen.
 *            Rows are top-level sessions. Row: status mark · title · starter
 *            (`initiator`: name, trigger slug, channel, API key) · child count
 *            and caret · time. A tap on the caret loads the children 20 at a
 *            time inside the tile ("Show more"). Its sub-session
 *            rows always follow inside the same tile, joined by a connector
 *            under the status mark, titles on the parent title's edge, time
 *            at the far right (`SubsessionTree`); a tap opens the parent
 *            session on that sub-session.
 *   button   New session, pinned at the bottom right over a fade of the page:
 *            the project drawer's bottom bar (`PinnedBar`). The list scrolls
 *            under it. It returns to project home, whose composer starts the
 *            session.
 *
 * Tap a row → the session opens in the view route, which replaces this page
 * (useCoveringRoute), so the stack stays one screen over project home.
 * Long press → `SessionActionsSheet` (Rename, Share, Restart sandbox, Stop,
 * Delete), opened through `openSessionActions` on `ProjectRouteValue` — the
 * same sheet instance the thread's `···` and the drawer's session-row long
 * press use (COR-140 Task 5, `components/session/SessionActionsSheet.tsx`).
 *
 * The list is always newest activity first (no sort control). Title, status,
 * grouping, relative time, search and status filtering all come from
 * lib/session/session-list (unit-tested).
 */

import * as React from 'react';
import { FlatList, RefreshControl, View, type ListRenderItem } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { useIsFocused } from 'expo-router/react-navigation';
import { directSubsessions } from '@kortix/sdk';
import { BottomSheetScrollView, type BottomSheetModal } from '@gorhom/bottom-sheet';
import { FunnelIcon as Funnel, NavigationArrowIcon, XIcon } from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PixelDeadFlower } from '@/components/kortix/PixelDeadFlower';
import { PageContent } from '@/components/kortix/page-content';
import { PageHeader } from '@/components/kortix/page-header';
import { PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import { SettingsGroup, SettingsGroupItem, SettingsRow } from '@/components/kortix/settings-list';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { useCoveringRoute, useProjectRoute } from '@/components/session/ProjectRoutes';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import {
  CONNECTOR_STROKE,
  SubsessionCountBadge,
  SubsessionTree,
  SubsessionTreeMemory,
  subsessionCountLabel,
} from '@/components/session/SessionSubsessionTree';
import { ExpandControl, SessionChildren, StarterLabel } from '@/components/session/SessionTreeParts';
import { useSessionStarterOf } from '@/components/session/DrawerSessionRows';
import { haptics } from '@/lib/haptics';
import { useProjectSessionsPaged } from '@/lib/projects/hooks';
import { sessionListState, shouldLoadMoreSessions } from '@/lib/session/session-pages';
import {
  SESSION_SCOPES,
  childCountOf,
  isParentExpanded,
  rootRowsOnly,
  searchQueryParam,
  startedByForScope,
} from '@/lib/session/session-tree';
import { useAuthContext } from '@/contexts';
import { parentKey, useSessionTreeStore } from '@/stores/session-tree-store';
import { needsYouBySession } from '@/lib/session/needs-you';
import { useReviewItems } from '@/lib/review/use-review';
import type { ProjectSession } from '@/lib/projects/projects-client';
import type { SessionStarter } from '@/lib/session/session-tree';
import {
  SESSION_STATUS_FILTERS,
  showSubsessionCountBadge,
  filterSessionsByStatus,
  groupSessionsByActivity,
  sessionDisplayStatus,
  sessionDisplayTitle,
  sessionLastActivityAt,
  sessionStatusFilterSummary,
  sessionStatusLabel,
  shortRelative,
  spokenRelative,
  type SessionStatusFilter,
} from '@/lib/session/session-list';
import { THEME } from '@/lib/utils/theme';
import { EMPTY_SESSION_FILTER, useSessionFilterStore } from '@/stores/session-filter-store';

/** Relative times ("5m") re-render on this interval so they do not freeze. */
const NOW_TICK_MS = 60_000;
/** `Button size="lg"`: the pinned New session button, as in the project drawer. */
const NEW_SESSION_BUTTON_HEIGHT = 44;

const sessionListItemKey = (item: SessionListItem) => item.key;

/** The search field waits this long after the last keystroke before it asks the server. */
const SEARCH_DEBOUNCE_MS = 250;

/** `value`, `delayMs` after it last changed. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/** Space between two groups: the settings screens' 18pt. */
const GROUP_GAP = 18;

// ── Row ──────────────────────────────────────────────────────────────────────

interface SessionRowProps {
  session: ProjectSession;
  now: number;
  /** A sub-agent session (spawned by another session in this group, COR-162):
   *  a short connector elbow joins the status mark, indenting the label past the
   *  usual leading slot — the row's own tile stays full width. */
  nested?: boolean;
  /** Pending review-inbox items from this session (`needsYouBySession`): > 0 marks it `needs-you`. */
  needsYouCount: number;
  /** Who started the run (`initiator`), after the title. */
  starter?: SessionStarter;
  /** The parent's children show under it (KRTX-639); `undefined` = no children. */
  childRows?: React.ReactNode;
  expanded?: boolean;
  onToggleChildren?: (session: ProjectSession) => void;
  /** A row tap opens the session on its root; a sub-session row passes that sub-session's id. */
  onOpen: (session: ProjectSession, focusRuntimeId?: string) => void;
  onActions: (session: ProjectSession) => void;
}

/**
 * Sub-session tree geometry, from the tile's left edge. The trunk runs down
 * the centre of the row's status mark: `SettingsRow` `px-4` (16) + half the
 * 20pt slot (10). Each sub-session title starts on the row's label edge:
 * `px-4` + the 20pt leading slot + its `mr-3` (12). A nested row's leading
 * adds the 12pt elbow and its `gap-1.5` (6) before the mark to both.
 */
const NESTED_LEAD = 12 + 6;
const TRUNK_X_TOP_LEVEL = 16 + 10;
const TEXT_X_TOP_LEVEL = 16 + 20 + 12;

/**
 * One `SettingsRow`: status mark · title · time (· sub-session count). No
 * chevron: the time holds the right edge. The session's sub-sessions follow
 * under it in the same tile (`SubsessionTree`), always.
 */
const SessionRow = React.memo(function SessionRow({
  session,
  now,
  nested = false,
  needsYouCount,
  starter,
  childRows,
  expanded = false,
  onToggleChildren,
  onOpen,
  onActions,
}: SessionRowProps) {
  const childCount = childCountOf(session);
  const title = sessionDisplayTitle(session);
  const status = sessionDisplayStatus(session, needsYouCount);
  const lastActivity = sessionLastActivityAt(session);
  const subsessions = React.useMemo(() => directSubsessions(session), [session]);
  const subsessionCount = subsessions.length;
  const openSubsession = React.useCallback(
    (childId: string) => onOpen(session, childId),
    [onOpen, session]
  );
  const accessibilityLabel = [
    title,
    nested ? 'sub-agent session' : null,
    sessionStatusLabel(status),
    spokenRelative(lastActivity, now),
    subsessionCount > 0 ? subsessionCountLabel(subsessionCount) : null,
    starter ? `started by ${starter.label}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const row = (
    <SettingsRow
      leading={
        nested ? (
          <View className="flex-row items-center gap-1.5">
            {/* Each row is its own tile, so no trunk can join the tiles: a
                short elbow in the connector stroke (`SubsessionTree`) marks
                the sub-agent instead of an icon. */}
            <View
              className="rounded-bl-md border-border"
              style={{
                width: 12,
                height: 10,
                marginTop: -10,
                borderLeftWidth: CONNECTOR_STROKE,
                borderBottomWidth: CONNECTOR_STROKE,
              }}
            />
            <SessionStatusMark status={status} />
          </View>
        ) : (
          <SessionStatusMark status={status} />
        )
      }
      label={title}
      value={shortRelative(lastActivity, now)}
      labelAccessory={
        starter || showSubsessionCountBadge(subsessionCount) ? (
          <View className="flex-row items-center gap-2">
            {starter ? <StarterLabel starter={starter} /> : null}
            {showSubsessionCountBadge(subsessionCount) ? <SubsessionCountBadge count={subsessionCount} /> : null}
          </View>
        ) : undefined
      }
      right={
        childCount > 0 && onToggleChildren ? (
          <ExpandControl
            count={childCount}
            expanded={expanded}
            onToggle={() => onToggleChildren(session)}
            title={title}
          />
        ) : null
      }
      onPress={() => onOpen(session)}
      onLongPress={() => onActions(session)}
      longPressLabel="Session actions"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Opens the session"
    />
  );
  if (subsessionCount === 0 && !(expanded && childRows)) return row;
  return (
    <View>
      {row}
      {expanded ? childRows : null}
      {/* No thread is open while this page shows (useCoveringRoute), so no
          sub-session row is highlighted. */}
      {subsessionCount > 0 ? (
      <View className="pb-2">
        <SubsessionTree
          parentId={session.session_id}
          subsessions={subsessions}
          parentTitle={title}
          activeRuntimeId={null}
          trunkX={TRUNK_X_TOP_LEVEL + (nested ? NESTED_LEAD : 0)}
          textX={TEXT_X_TOP_LEVEL + (nested ? NESTED_LEAD : 0)}
          now={now}
          onPressSubsession={openSubsession}
        />
      </View>
      ) : null}
    </View>
  );
});

// ── List items ───────────────────────────────────────────────────────────────

/**
 * One list item: a group title, or one row with its place in its group
 * (`SettingsGroupItem` corners). `first` marks the first item of every group
 * after the first: the group gap goes above it.
 */
export type SessionListItem =
  | { kind: 'title'; key: string; title: string; first: boolean }
  | { kind: 'row'; key: string; session: ProjectSession; index: number; count: number; first: boolean };

/** The groups as one flat list, in order. Titles only when `showHeaders`. */
export function sessionListItems(
  sections: readonly { id: string; label: string; sessions: ProjectSession[] }[],
  showHeaders: boolean
): SessionListItem[] {
  const items: SessionListItem[] = [];
  sections.forEach((section, sectionIndex) => {
    let first = sectionIndex > 0;
    if (showHeaders) {
      items.push({ kind: 'title', key: `title:${section.id}`, title: section.label, first });
      first = false;
    }
    section.sessions.forEach((session, index) => {
      items.push({
        kind: 'row',
        key: session.session_id,
        session,
        index,
        count: section.sessions.length,
        first: index === 0 && first,
      });
    });
  });
  return items;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export interface ProjectSessionsPageProps {
  /** Focus the search field on mount — the drawer's Search row. */
  autoFocusSearch?: boolean;
}

export function ProjectSessionsPage({ autoFocusSearch = false }: ProjectSessionsPageProps = {}) {
  const { projectId, openDrawer, newSession, openSessionActions, isDrawerOpen } = useProjectRoute();
  // Opens a row's session once; also replaces this page with the view when a
  // session opens without a row tap (drawer row, notification, deep link).
  const openSession = useCoveringRoute();
  const isFocused = useIsFocused();
  // One loader at a time (KRTX-244): this page's loaders draw only while it is
  // the surface in front — not under the open drawer (which loads the same
  // list with its own loader), not while the view replaces it on a row tap.
  const showLoaders = isFocused && !isDrawerOpen;
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // Poll for provisioning rows only while this page is on top.
  // KRTX-639: the server searches and filters. Top-level sessions, a page (50)
  // at a time, narrowed by starter (`started_by`) and search text (`q`, over
  // every session the viewer may see, not the loaded pages). Children load
  // per parent on expand.
  const viewerId = useAuthContext().user?.id ?? null;
  const storedFilter =
    useSessionFilterStore((state) => state.byProject[projectId]) ?? EMPTY_SESSION_FILTER;
  const query = storedFilter.query;
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const serverQuery = searchQueryParam(debouncedQuery);
  const sessionsQuery = useProjectSessionsPaged(projectId, {
    poll: isFocused,
    parent: 'root',
    startedBy: startedByForScope(storedFilter.scope),
    q: serverQuery,
  });
  const allSessions = React.useMemo(() => rootRowsOnly(sessionsQuery.sessions), [sessionsQuery.sessions]);

  // No haptic on a row tap: ProjectScreen's open handler fires the one tap.

  // ── Clock for grouping and relative time ──
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);
  React.useEffect(() => {
    setNow(Date.now());
  }, [sessionsQuery.dataUpdatedAt]);

  // ── Search, starter, status filter, and grouping ──
  // Per project, in `useSessionFilterStore`: opening a session unmounts this
  // page, and coming back must find the same search and filter (KRTX-250).
  // Empty set = no status filter (every session passes).
  const statusFilter = React.useMemo<ReadonlySet<SessionStatusFilter>>(
    () => new Set(storedFilter.statuses),
    [storedFilter.statuses]
  );
  const hasSessions = allSessions.length > 0;
  const statusFilterActive = statusFilter.size > 0;
  const filterActive = query.trim().length > 0 || statusFilterActive || storedFilter.scope !== 'all';

  const setQuery = React.useCallback(
    (text: string) => useSessionFilterStore.getState().setQuery(projectId, text),
    [projectId]
  );
  const filterSheetRef = React.useRef<BottomSheetModal>(null);
  const toggleStatusFilter = React.useCallback(
    (status: SessionStatusFilter) => {
      haptics.selection();
      useSessionFilterStore.getState().toggleStatus(projectId, status);
    },
    [projectId]
  );
  // The page's one Reset: search and statuses together (chip, sheet, no-match state).
  const resetFilters = React.useCallback(() => {
    haptics.tap();
    useSessionFilterStore.getState().resetProject(projectId);
  }, [projectId]);

  // Sessions that wait on the user, from the review inbox. ProjectScreen
  // polls it; this reads the same query cache without a second poll.
  const reviewItems = useReviewItems(projectId, { poll: false });
  const needsYou = React.useMemo(() => needsYouBySession(reviewItems.data ?? []), [reviewItems.data]);

  // The status filter is client-side over the loaded rows (the server has no
  // status param); search and starter are the server's.
  const filtered = React.useMemo(
    () => filterSessionsByStatus(allSessions, statusFilter, needsYou),
    [allSessions, statusFilter, needsYou]
  );
  const grouped = React.useMemo(() => groupSessionsByActivity(filtered, now), [filtered, now]);
  const listItems = React.useMemo(
    () => sessionListItems(grouped.sections, grouped.showHeaders),
    [grouped]
  );

  // ── Refresh ──
  const [refreshing, setRefreshing] = React.useState(false);
  // `refetch` is stable; the query object is new on every render.
  const refetchSessions = sessionsQuery.refetch;
  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await refetchSessions();
    } finally {
      setRefreshing(false);
    }
  }, [refetchSessions]);

  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = sessionsQuery;
  const onEndReached = React.useCallback(() => {
    if (shouldLoadMoreSessions({ hasNextPage, isFetchingNextPage, isRefreshing: refreshing })) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, refreshing, fetchNextPage]);

  // The server answered for the current search once its first page landed.
  // The list shows "No matching sessions" only then, never while a new query
  // is still in flight (the debounce, or the fetch).
  const searchSettled = debouncedQuery === query && !sessionsQuery.isFetching;

  // ── Render ──
  // One list item per row and per group title (`sessionListItems`): each row
  // is a `SettingsGroupItem`, so the groups read as the settings screens'
  // `SettingsGroup`s. The title shows only when more than one group has
  // sessions.
  //
  // KRTX-639: a top-level row with children shows a count and a caret. The
  // children load 20 at a time when it opens (`SessionChildren`) and render
  // nested inside the parent's tile. A search that matched only through a
  // child opens the parent and narrows its children to the match.
  const choices = useSessionTreeStore((state) => state.choices);
  const setChoice = useSessionTreeStore((state) => state.setChoice);
  const showStarter = storedFilter.scope !== 'mine';
  const starterOf = useSessionStarterOf(viewerId);
  const isExpanded = React.useCallback(
    (session: ProjectSession) =>
      isParentExpanded({
        explicit: choices[parentKey(projectId, session.session_id)],
        isActiveParent: false,
        searchMatch: serverQuery ? session.search_match : undefined,
      }),
    [choices, projectId, serverQuery]
  );
  const toggleParent = React.useCallback(
    (session: ProjectSession) => setChoice(parentKey(projectId, session.session_id), !isExpanded(session)),
    [setChoice, projectId, isExpanded]
  );
  // A child row of an expanded parent (`SessionChildren`).
  const renderChild = React.useCallback(
    (child: ProjectSession) => (
      <SessionRow
        key={child.session_id}
        session={child}
        now={now}
        nested
        needsYouCount={needsYou.get(child.session_id)?.count ?? 0}
        onOpen={openSession}
        onActions={openSessionActions}
      />
    ),
    [now, needsYou, openSession, openSessionActions]
  );
  const renderItem = React.useCallback<ListRenderItem<SessionListItem>>(
    ({ item }) => {
      const gap = item.first ? { marginTop: GROUP_GAP } : undefined;
      if (item.kind === 'title') {
        // `SettingsGroup`'s title.
        return (
          <Text variant="muted" className="mb-2 px-4" style={gap}>
            {item.title}
          </Text>
        );
      }
      const session = item.session;
      const expanded = isExpanded(session);
      return (
        <View style={gap}>
          <SettingsGroupItem index={item.index} count={item.count}>
            <SessionRow
              session={session}
              now={now}
              needsYouCount={needsYou.get(session.session_id)?.count ?? 0}
              starter={showStarter ? starterOf(session) : undefined}
              expanded={expanded}
              onToggleChildren={toggleParent}
              childRows={
                expanded ? (
                  <SessionChildren
                    projectId={projectId}
                    parent={session}
                    q={session.search_match === 'child' ? serverQuery : undefined}
                    showLoader={showLoaders}
                    renderChild={renderChild}
                  />
                ) : undefined
              }
              onOpen={openSession}
              onActions={openSessionActions}
            />
          </SettingsGroupItem>
        </View>
      );
    },
    [
      now,
      needsYou,
      showStarter,
      starterOf,
      isExpanded,
      toggleParent,
      projectId,
      serverQuery,
      showLoaders,
      renderChild,
      openSession,
      openSessionActions,
    ]
  );

  // ── New session: the project drawer's pinned button, at the bottom right ──
  const listBottomInset = usePinnedBarInset(NEW_SESSION_BUTTON_HEIGHT);
  const pageBackground = isDark ? THEME.dark.background : THEME.light.background;
  const mutedColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const handleNewSession = React.useCallback(() => {
    haptics.tap();
    newSession();
  }, [newSession]);

  // loading / error / empty / rows — shared with the project drawer
  // (lib/session/session-pages) so a failed fetch, or a first load paused
  // offline, never reads as "No sessions yet" (COR-146). With a search, a
  // starter or a status filter active, an empty list is "No matching
  // sessions" — and only once the server has answered for the current search.
  const rawListState = sessionListState({
    isPending: sessionsQuery.isPending,
    isError: sessionsQuery.isError,
    hasSessions,
  });
  const loading = rawListState === 'loading';
  const loadFailed = rawListState === 'error';
  // The project has no sessions at all: only knowable with no filter on.
  const projectEmpty = !filterActive && rawListState === 'empty';
  const emptyMessage = loadFailed
    ? 'Unable to load sessions. Pull to refresh.'
    : projectEmpty
      ? 'No sessions yet'
      : 'No matching sessions';
  // Rows exist on later pages but none of the loaded ones pass the status
  // filter: offer the next page instead of a verdict.
  const moreBehindStatusFilter = statusFilterActive && filtered.length === 0 && hasNextPage;

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        title="Sessions"
        onOpenDrawer={openDrawer}
        rightActions={
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            onPress={() => {
              haptics.tap();
              filterSheetRef.current?.present();
            }}
            accessibilityLabel="Filter sessions"
            accessibilityHint="Opens the session status filter">
            <Icon
              as={Funnel}
              size={20}
              className={statusFilterActive ? 'text-primary' : 'text-foreground'}
              weight={statusFilterActive ? 'fill' : undefined}
            />
          </Button>
        }
      />

      <PageContent>
        {loading ? (
          <View className="flex-1 items-center justify-center" style={{ paddingBottom: insets.bottom }}>
            {showLoaders ? <KortixLoader /> : null}
          </View>
        ) : (
          <>
            {hasSessions || filterActive ? (
              <SearchListHeader
                value={query}
                onChangeText={setQuery}
                placeholder="Search sessions"
                inputProps={{ accessibilityLabel: 'Search sessions', autoFocus: autoFocusSearch }}
              />
            ) : null}
            <View className="flex-row gap-2 px-4 pb-2" accessibilityRole="tablist">
              {SESSION_SCOPES.map(({ value, label }) => (
                <Button
                  key={value}
                  variant={storedFilter.scope === value ? 'secondary' : 'ghost'}
                  size="sm"
                  className="rounded-full"
                  onPress={() => {
                    haptics.selection();
                    useSessionFilterStore.getState().setScope(projectId, value);
                  }}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: storedFilter.scope === value }}>
                  <Text>{label}</Text>
                </Button>
              ))}
            </View>
            {statusFilterActive ? (
              // The active status filter, visible without opening the sheet.
              // Tap = Reset (search + statuses).
              <View className="flex-row px-4 pb-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="rounded-full"
                  onPress={resetFilters}
                  accessibilityLabel={`Filtered by ${sessionStatusFilterSummary(statusFilter)}. Reset`}
                  accessibilityHint="Shows every session again">
                  <Text>{sessionStatusFilterSummary(statusFilter)}</Text>
                  <Icon as={XIcon} size={14} className="text-muted-foreground" />
                </Button>
              </View>
            ) : null}
            {/* Expanded sub-session trees survive virtualisation. */}
            <SubsessionTreeMemory>
            <FlatList
              data={listItems}
              keyExtractor={sessionListItemKey}
              renderItem={renderItem}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
              onEndReached={onEndReached}
              onEndReachedThreshold={0.6}
              ListFooterComponent={
                isFetchingNextPage && listItems.length > 0 && showLoaders ? (
                  <View className="items-center py-4">
                    <KortixLoader size="small" />
                  </View>
                ) : null
              }
              style={{ flex: 1 }}
              contentContainerStyle={{
                flexGrow: 1,
                paddingHorizontal: 16,
                paddingTop: 4,
                // The list scrolls under the pinned New session button; its last
                // row rests above it.
                paddingBottom: listBottomInset,
              }}
              ListEmptyComponent={
                projectEmpty ? (
                  // The project has no sessions at all: the drawer's wilted
                  // flower. Errors and empty filter results keep their text.
                  <View
                    className="flex-1 items-center justify-center px-8"
                    accessible
                    accessibilityRole="image"
                    accessibilityLabel={emptyMessage}>
                    <PixelDeadFlower color={mutedColor} size={96} animate={isFocused} />
                  </View>
                ) : !loadFailed && !searchSettled ? (
                  // The server has not answered for this search yet: no verdict.
                  <View
                    className="flex-1 items-center justify-center px-8"
                    accessible
                    accessibilityLabel="Searching sessions">
                    {showLoaders ? <KortixLoader size="small" /> : null}
                  </View>
                ) : (
                  <View className="flex-1 items-center justify-center gap-3 px-8">
                    <Text variant="muted" className="text-center">
                      {emptyMessage}
                    </Text>
                    {moreBehindStatusFilter ? (
                      <Button variant="secondary" size="sm" className="rounded-full" onPress={() => void fetchNextPage()}>
                        <Text>Show older sessions</Text>
                      </Button>
                    ) : null}
                    {!loadFailed && filterActive ? (
                      <Button variant="secondary" size="sm" className="rounded-full" onPress={resetFilters}>
                        <Text>Reset</Text>
                      </Button>
                    ) : null}
                  </View>
                )
              }
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground}
                />
              }
            />
            </SubsessionTreeMemory>
          </>
        )}
      </PageContent>

      {/* The project drawer's pinned bar (`PinnedBar`), its New session button at
          the bottom right. Hidden while the page loads. */}
      {loading ? null : (
        <PinnedBar
          controlHeight={NEW_SESSION_BUTTON_HEIGHT}
          background={pageBackground}
          className="justify-end px-5">
          <Button size="lg" className="rounded-full" onPress={handleNewSession}>
            {/* Web's New session glyph, flipped horizontally: tip up-right (the drawer's). */}
            <Icon as={NavigationArrowIcon} size={20} style={{ transform: [{ scaleX: -1 }] }} />
            <Text>New session</Text>
          </Button>
        </PinnedBar>
      )}

      {/* Filter: which statuses show in the timeline. Empty selection = every
          status. A basic, single group of toggleable rows — no date range or
          sort, unlike web's fuller filter panel. */}
      <KortixBottomSheetModal ref={filterSheetRef} title="Filter sessions" enableDynamicSizing enablePanDownToClose>
        <BottomSheetScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
          <SettingsGroup>
            {SESSION_STATUS_FILTERS.map((status) => (
              <SettingsRow
                key={status}
                leading={<SessionStatusMark status={status} />}
                label={sessionStatusLabel(status)}
                checked={statusFilter.has(status)}
                right={null}
                onPress={() => toggleStatusFilter(status)}
              />
            ))}
          </SettingsGroup>
          {statusFilterActive ? (
            <Button variant="secondary" size="lg" className="mt-4 rounded-full" onPress={resetFilters}>
              <Text>Reset</Text>
            </Button>
          ) : null}
        </BottomSheetScrollView>
      </KortixBottomSheetModal>
    </View>
  );
}
