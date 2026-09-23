/**
 * ProjectSessionsPage — every session of a project, at `/projects/[id]/sessions`
 * (opened from the project drawer's Search row, `autoFocusSearch` true so the
 * field is already focused; a session row's own navigation opens it without
 * that focus).
 *
 *   header   `PageHeader` (Jay, 2026-09-22): hamburger, "Sessions" title, and
 *            a Filter action at the right — the same header every other
 *            project tool page uses.
 *   search   SearchListHeader, filters by display title
 *   filter   Filter sheet (`SettingsGroup` of toggleable status rows: Needs
 *            you / Running / Starting / Stopped / Failed). Empty selection
 *            shows every status; toggling narrows the timeline to just the
 *            checked ones. Basic on purpose — no date range or sort, unlike
 *            web's fuller filter panel.
 *   list     Today / Yesterday / This week / Older, one `SettingsGroup` of
 *            `SettingsRow`s each (the settings screens' layout); a group's title
 *            shows only when more than one group has sessions.
 *            Row: status mark · title · time
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
import { BottomSheetScrollView, type BottomSheetModal } from '@gorhom/bottom-sheet';
import { ArrowElbowDownRightIcon, FunnelIcon as Funnel, NavigationArrowIcon } from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PageContent } from '@/components/kortix/page-content';
import { PageHeader } from '@/components/kortix/page-header';
import { PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { useCoveringRoute, useProjectRoute } from '@/components/session/ProjectRoutes';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import { haptics } from '@/lib/haptics';
import { useProjectSessionsPaged } from '@/lib/projects/hooks';
import { sessionListState, shouldLoadMoreSessions } from '@/lib/session/session-pages';
import type { ProjectSession } from '@/lib/projects/projects-client';
import {
  SESSION_STATUS_FILTERS,
  filterSessionsByStatus,
  filterSessionsByTitle,
  groupSessionsByActivity,
  groupSessionsByCoordinator,
  sessionDisplayStatus,
  sessionDisplayTitle,
  sessionLastActivityAt,
  sessionStatusLabel,
  shortRelative,
  spokenRelative,
  type SessionDisplayStatus,
} from '@/lib/session/session-list';
import { THEME } from '@/lib/utils/theme';

/** Relative times ("5m") re-render on this interval so they do not freeze. */
const NOW_TICK_MS = 60_000;
/** `Button size="lg"`: the pinned New session button, as in the project drawer. */
const NEW_SESSION_BUTTON_HEIGHT = 44;

/** Space between two groups: the settings screens' 18pt. */
function GroupGap() {
  return <View style={{ height: 18 }} />;
}

// ── Row ──────────────────────────────────────────────────────────────────────

interface SessionRowProps {
  session: ProjectSession;
  now: number;
  /** A sub-agent session (spawned by another session in this group, COR-162):
   *  a small branch mark joins the status mark, indenting the label past the
   *  usual leading slot — the row's own tile stays full width. */
  nested?: boolean;
  onOpen: (session: ProjectSession) => void;
  onActions: (session: ProjectSession) => void;
}

/** One `SettingsRow`: status mark · title · time. No chevron: the time holds the right edge. */
const SessionRow = React.memo(function SessionRow({
  session,
  now,
  nested = false,
  onOpen,
  onActions,
}: SessionRowProps) {
  const title = sessionDisplayTitle(session);
  const status = sessionDisplayStatus(session);
  const lastActivity = sessionLastActivityAt(session);
  const accessibilityLabel = nested
    ? `${title}, sub-agent session, ${sessionStatusLabel(status)}, ${spokenRelative(lastActivity, now)}`
    : `${title}, ${sessionStatusLabel(status)}, ${spokenRelative(lastActivity, now)}`;

  return (
    <SettingsRow
      leading={
        nested ? (
          <View className="flex-row items-center gap-1.5">
            <Icon as={ArrowElbowDownRightIcon} size={12} className="text-muted-foreground/60" />
            <SessionStatusMark status={status} />
          </View>
        ) : (
          <SessionStatusMark status={status} />
        )
      }
      label={title}
      value={shortRelative(lastActivity, now)}
      right={null}
      onPress={() => onOpen(session)}
      onLongPress={() => onActions(session)}
      longPressLabel="Session actions"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Opens the session"
    />
  );
});

// ── Page ─────────────────────────────────────────────────────────────────────

interface SessionSection {
  key: string;
  title: string;
  data: ProjectSession[];
}

export interface ProjectSessionsPageProps {
  /** Focus the search field on mount — the drawer's Search row. */
  autoFocusSearch?: boolean;
}

export function ProjectSessionsPage({ autoFocusSearch = false }: ProjectSessionsPageProps = {}) {
  const { projectId, openDrawer, newSession, openSessionActions } = useProjectRoute();
  // Opens a row's session once; also replaces this page with the view when a
  // session opens without a row tap (drawer row, notification, deep link).
  const openSession = useCoveringRoute();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // Poll for provisioning rows only while this page is on top.
  // Every session, a page (50) at a time: the list loads the next page as it
  // nears its end. Search and groups work on the rows loaded so far; a search
  // with few matches leaves the list short, so it reaches its end at once and
  // keeps loading pages until the matches fill the screen or the list ends.
  const sessionsQuery = useProjectSessionsPaged(projectId, { poll: isFocused });
  const allSessions = sessionsQuery.sessions;

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

  // ── Search, status filter, and grouping ──
  const [query, setQuery] = React.useState('');
  const hasSessions = allSessions.length > 0;
  React.useEffect(() => {
    // Nothing left to search: leave no hidden query behind.
    if (!hasSessions && query) setQuery('');
  }, [hasSessions, query]);

  // Empty set = no filter (every session passes). The filter sheet toggles
  // membership; `Clear filters` (shown only when non-empty) resets to it.
  const [statusFilter, setStatusFilter] = React.useState<Set<SessionDisplayStatus>>(
    () => new Set()
  );
  const filterSheetRef = React.useRef<BottomSheetModal>(null);
  const toggleStatusFilter = React.useCallback((status: SessionDisplayStatus) => {
    haptics.selection();
    setStatusFilter((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);
  const clearStatusFilter = React.useCallback(() => {
    haptics.tap();
    setStatusFilter(new Set());
  }, []);

  const filtered = React.useMemo(
    () => filterSessionsByStatus(filterSessionsByTitle(allSessions, query), statusFilter),
    [allSessions, query, statusFilter]
  );
  const grouped = React.useMemo(() => groupSessionsByActivity(filtered, now), [filtered, now]);
  const sections = React.useMemo<SessionSection[]>(
    () =>
      grouped.sections.map((section) => ({
        key: section.id,
        title: section.label,
        data: section.sessions,
      })),
    [grouped]
  );

  // ── Refresh ──
  const [refreshing, setRefreshing] = React.useState(false);
  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await sessionsQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [sessionsQuery]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = sessionsQuery;
  const onEndReached = React.useCallback(() => {
    if (shouldLoadMoreSessions({ hasNextPage, isFetchingNextPage, isRefreshing: refreshing })) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, refreshing, fetchNextPage]);

  // ── Render ──
  // One list item per group: a `SettingsGroup` of `SettingsRow`s, the settings
  // screens' layout. The title shows only when more than one group has sessions.
  //
  // Within each activity-day section, a sub-agent session (spawned by
  // another session in that SAME section, COR-162) nests as an indented row
  // right after its coordinator (`groupSessionsByCoordinator`) — mirroring
  // web, which composes the same two groupings (activity day, then
  // coordinator) in that order. A coordinator whose activity bucket differs
  // from its child's (rare — spawning is normally near-simultaneous) leaves
  // the child top-level in its own section instead of disappearing.
  const showHeaders = grouped.showHeaders;
  const renderSection = React.useCallback<ListRenderItem<SessionSection>>(
    ({ item: section }) => (
      <SettingsGroup title={showHeaders ? section.title : undefined}>
        {/* `flatMap`, not a nested `React.Fragment` per group: `SettingsGroup`
            wraps each TOP-LEVEL child in its own rounded tile
            (`React.Children.toArray`, which flattens a plain array), so a
            coordinator and its sub-agent children must each be a top-level
            element here — a `Fragment` would fuse a whole group into one
            shared tile instead of one tile per row. */}
        {groupSessionsByCoordinator(section.data).flatMap((group) => [
          <SessionRow
            key={group.session.session_id}
            session={group.session}
            now={now}
            onOpen={openSession}
            onActions={openSessionActions}
          />,
          ...group.children.map((child) => (
            <SessionRow
              key={child.session_id}
              session={child}
              now={now}
              nested
              onOpen={openSession}
              onActions={openSessionActions}
            />
          )),
        ])}
      </SettingsGroup>
    ),
    [showHeaders, now, openSession, openSessionActions]
  );

  // ── New session: the project drawer's pinned button, at the bottom right ──
  const listBottomInset = usePinnedBarInset(NEW_SESSION_BUTTON_HEIGHT);
  const pageBackground = isDark ? THEME.dark.background : THEME.light.background;
  const handleNewSession = React.useCallback(() => {
    haptics.tap();
    newSession();
  }, [newSession]);

  // loading / error / empty / rows — shared with the project drawer
  // (lib/session/session-pages) so a failed fetch never reads as "No
  // sessions yet" (COR-146). "No matching sessions" (a search/filter with no
  // hits over rows that did load) is this page's own case, not part of the
  // shared decision.
  const rawListState = sessionListState({
    isLoading: sessionsQuery.isLoading,
    isError: sessionsQuery.isError,
    hasSessions,
  });
  const loading = rawListState === 'loading';
  const loadFailed = rawListState === 'error';
  const emptyMessage = loadFailed
    ? 'Unable to load sessions. Pull to refresh.'
    : !hasSessions
      ? 'No sessions yet'
      : 'No matching sessions';

  const filterActive = statusFilter.size > 0;

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
              className={filterActive ? 'text-primary' : 'text-foreground'}
              weight={filterActive ? 'fill' : undefined}
            />
          </Button>
        }
      />

      <PageContent>
        {loading ? (
          <View className="flex-1 items-center justify-center" style={{ paddingBottom: insets.bottom }}>
            <KortixLoader />
          </View>
        ) : (
          <>
            {hasSessions ? (
              <SearchListHeader
                value={query}
                onChangeText={setQuery}
                placeholder="Search sessions"
                inputProps={{ accessibilityLabel: 'Search sessions', autoFocus: autoFocusSearch }}
              />
            ) : null}
            <FlatList
              data={sections}
              keyExtractor={(section) => section.key}
              renderItem={renderSection}
              ItemSeparatorComponent={GroupGap}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
              onEndReached={onEndReached}
              onEndReachedThreshold={0.6}
              ListFooterComponent={
                isFetchingNextPage ? (
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
                <View className="flex-1 items-center justify-center px-8">
                  <Text variant="muted" className="text-center">
                    {emptyMessage}
                  </Text>
                </View>
              }
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground}
                />
              }
            />
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
          {filterActive ? (
            <Button
              variant="secondary"
              size="lg"
              className="mt-4 rounded-full"
              onPress={clearStatusFilter}>
              <Text>Clear filters</Text>
            </Button>
          ) : null}
        </BottomSheetScrollView>
      </KortixBottomSheetModal>
    </View>
  );
}
