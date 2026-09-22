/**
 * ProjectSessionsPage — every session of a project, at `/projects/[id]/sessions`
 * (opened from the project drawer's Sessions button).
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
 * Long press → the options sheet (`KortixBottomSheetModal`, no close button,
 * content height with a full-height stop above it): Rename, Share, Restart, Stop
 * (running only), Delete. Rename and Share push their form in place of the
 * options (`sheet-push`), with Back to return. Delete confirms in a dialog that
 * opens only after the sheet has closed, so two overlays never stack.
 *
 * The list is always newest activity first (no sort control). Title, status,
 * grouping, relative time, search and status filtering all come from
 * lib/session/session-list (unit-tested).
 */

import * as React from 'react';
import { FlatList, RefreshControl, View, type ListRenderItem } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router/react-navigation';
import { BottomSheetScrollView, type BottomSheetModal } from '@gorhom/bottom-sheet';
import Animated from 'react-native-reanimated';
import { FunnelIcon as Funnel, NavigationArrowIcon, PencilIcon as Pencil, ArrowCounterClockwiseIcon as RotateCcw, ExportIcon as Share, SquareIcon as Square, TrashIcon as Trash2 } from '@/lib/icons';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PageContent } from '@/components/kortix/page-content';
import { PageHeader } from '@/components/kortix/page-header';
import { PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { KortixBottomSheetModal, SheetTitleRow } from '@/components/kortix/sheet';
import { POP_IN, PUSH_IN, SheetBackButton } from '@/components/kortix/sheet-push';
import { useToast } from '@/components/kortix/toast-provider';
import { useCoveringRoute, useProjectRoute } from '@/components/session/ProjectRoutes';
import { SessionRenameForm } from '@/components/session/SessionRenameForm';
import { SessionShareForm } from '@/components/session/SessionShareForm';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import { haptics } from '@/lib/haptics';
import { projectKeys, useProjectSessionsPaged } from '@/lib/projects/hooks';
import { shouldLoadMoreSessions } from '@/lib/session/session-pages';
import {
  deleteProjectSession,
  restartProjectSession,
  stopProjectSession,
  type ProjectSession,
} from '@/lib/projects/projects-client';
import {
  SESSION_STATUS_FILTERS,
  filterSessionsByStatus,
  filterSessionsByTitle,
  groupSessionsByActivity,
  sessionDisplayStatus,
  sessionDisplayTitle,
  sessionLastActivityAt,
  sessionStatusLabel,
  shortRelative,
  spokenRelative,
  type SessionDisplayStatus,
} from '@/lib/session/session-list';
import { THEME } from '@/lib/utils/theme';
import { useTabStore } from '@/stores/tab-store';

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
  onOpen: (session: ProjectSession) => void;
  onActions: (session: ProjectSession) => void;
}

/** One `SettingsRow`: status mark · title · time. No chevron: the time holds the right edge. */
const SessionRow = React.memo(function SessionRow({
  session,
  now,
  onOpen,
  onActions,
}: SessionRowProps) {
  const title = sessionDisplayTitle(session);
  const status = sessionDisplayStatus(session);
  const lastActivity = sessionLastActivityAt(session);

  return (
    <SettingsRow
      leading={<SessionStatusMark status={status} />}
      label={title}
      value={shortRelative(lastActivity, now)}
      right={null}
      onPress={() => onOpen(session)}
      onLongPress={() => onActions(session)}
      longPressLabel="Session actions"
      accessibilityLabel={`${title}, ${sessionStatusLabel(status)}, ${spokenRelative(lastActivity, now)}`}
      accessibilityHint="Opens the session"
    />
  );
});

// ── Page ─────────────────────────────────────────────────────────────────────

/** The options sheet's view: its rows, or a form pushed over them. */
type SheetView = 'options' | 'rename' | 'share';
const PUSHED_VIEW_TITLE: Record<Exclude<SheetView, 'options'>, string> = {
  rename: 'Rename session',
  share: 'Share session',
};
/** The full-height stop above the content height: drag the sheet up to reach it. */
const OPTIONS_SHEET_SNAP_POINTS = ['100%'];

interface SessionSection {
  key: string;
  title: string;
  data: ProjectSession[];
}

export function ProjectSessionsPage() {
  const { projectId, openDrawer, newSession } = useProjectRoute();
  // Opens a row's session once; also replaces this page with the view when a
  // session opens without a row tap (drawer row, notification, deep link).
  const openSession = useCoveringRoute();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const toast = useToast();
  const queryClient = useQueryClient();

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
  const invalidateSessions = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) }),
    [queryClient, projectId]
  );
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

  // ── Action sheet ──
  const actionSheetRef = React.useRef<BottomSheetModal>(null);
  const [sheetView, setSheetView] = React.useState<SheetView>('options');
  // True once the user came back from Rename: only then the options slide in.
  const [returning, setReturning] = React.useState(false);
  const [menuSession, setMenuSession] = React.useState<ProjectSession | null>(null);
  // Set before the sheet closes; read when its close animation ends.
  // Delete confirms in a dialog, which opens only after the sheet has closed.
  const deleteAfterCloseRef = React.useRef(false);

  const openActions = React.useCallback((session: ProjectSession) => {
    haptics.medium();
    setMenuSession(session);
  }, []);

  React.useEffect(() => {
    if (menuSession) actionSheetRef.current?.present();
  }, [menuSession]);

  // The live row, so a refetch while the sheet is open reaches its forms.
  const liveRow = (session: ProjectSession) =>
    allSessions.find((s) => s.session_id === session.session_id) ?? session;

  const [confirmDelete, setConfirmDelete] = React.useState<ProjectSession | null>(null);
  // The title of the last delete target. It is not cleared on close, so the
  // dialog keeps its text while its close animation runs.
  const [deleteTitle, setDeleteTitle] = React.useState('');
  const [deleteFailed, setDeleteFailed] = React.useState(false);

  const handleSheetDismiss = React.useCallback(() => {
    const session = menuSession;
    const confirm = deleteAfterCloseRef.current;
    deleteAfterCloseRef.current = false;
    setMenuSession(null);
    setSheetView('options');
    setReturning(false);
    if (!session || !confirm) return;
    setDeleteFailed(false);
    setDeleteTitle(sessionDisplayTitle(session));
    setConfirmDelete(session);
  }, [menuSession]);

  const pushView = React.useCallback((view: Exclude<SheetView, 'options'>) => {
    haptics.tap();
    setSheetView(view);
    // Rename goes to full height (Jay, 2026-09-22): the field sits at the top,
    // clear of the keyboard, and the sheet does not resize as the keyboard moves.
    if (view === 'rename') actionSheetRef.current?.snapToPosition('100%');
  }, []);
  const popView = React.useCallback(() => {
    haptics.tap();
    setReturning(true);
    setSheetView('options');
    // Back to the content height: index 0, the stop under the full-height one.
    actionSheetRef.current?.snapToIndex(0);
  }, []);
  const closeSheet = React.useCallback(() => actionSheetRef.current?.dismiss(), []);

  // Restart and Stop open no overlay: close the sheet and run at once.
  const busyRef = React.useRef(new Set<string>());
  const runLifecycle = React.useCallback(
    async (
      session: ProjectSession,
      kind: 'restart' | 'stop',
      call: (projectId: string, sessionId: string) => Promise<unknown>,
      messages: { success: string; failure: string }
    ) => {
      const key = `${kind}:${session.session_id}`;
      if (busyRef.current.has(key)) return;
      busyRef.current.add(key);
      try {
        await call(projectId, session.session_id);
        haptics.success();
        toast.success(messages.success);
      } catch {
        haptics.warning();
        toast.error(messages.failure);
      } finally {
        busyRef.current.delete(key);
        void invalidateSessions();
      }
    },
    [projectId, toast, invalidateSessions]
  );

  const handleRestart = React.useCallback(() => {
    if (!menuSession) return;
    haptics.tap();
    actionSheetRef.current?.dismiss();
    void runLifecycle(menuSession, 'restart', restartProjectSession, {
      success: 'Session restarting',
      failure: 'Unable to restart the session. Try again.',
    });
  }, [menuSession, runLifecycle]);

  const handleStop = React.useCallback(() => {
    if (!menuSession) return;
    haptics.tap();
    actionSheetRef.current?.dismiss();
    void runLifecycle(menuSession, 'stop', stopProjectSession, {
      success: 'Session stopped',
      failure: 'Unable to stop the session. Try again.',
    });
  }, [menuSession, runLifecycle]);

  // ── Delete ──
  const deleteSession = useMutation({
    mutationFn: (session: ProjectSession) => deleteProjectSession(projectId, session.session_id),
  });

  const confirmDeleteSession = React.useCallback(async () => {
    if (!confirmDelete || deleteSession.isPending) return;
    haptics.medium();
    setDeleteFailed(false);
    try {
      await deleteSession.mutateAsync(confirmDelete);
      // Mirrors ProjectScreen's delete: drop the session's tab, so the store
      // never points at a deleted session and no dead tab survives.
      const tabs = useTabStore.getState();
      if (confirmDelete.opencode_session_id) {
        tabs.closeTab(confirmDelete.opencode_session_id);
      } else if (tabs.activeSessionId === confirmDelete.session_id) {
        tabs.navigateToSession(null);
      }
      haptics.success();
      toast.success('Session deleted');
      setConfirmDelete(null);
    } catch {
      haptics.warning();
      setDeleteFailed(true);
    } finally {
      void invalidateSessions();
    }
  }, [confirmDelete, deleteSession, toast, invalidateSessions]);

  // ── Render ──
  // One list item per group: a `SettingsGroup` of `SettingsRow`s, the settings
  // screens' layout. The title shows only when more than one group has sessions.
  const showHeaders = grouped.showHeaders;
  const renderSection = React.useCallback<ListRenderItem<SessionSection>>(
    ({ item: section }) => (
      <SettingsGroup title={showHeaders ? section.title : undefined}>
        {section.data.map((session) => (
          <SessionRow
            key={session.session_id}
            session={session}
            now={now}
            onOpen={openSession}
            onActions={openActions}
          />
        ))}
      </SettingsGroup>
    ),
    [showHeaders, now, openSession, openActions]
  );

  // ── New session: the project drawer's pinned button, at the bottom right ──
  const listBottomInset = usePinnedBarInset(NEW_SESSION_BUTTON_HEIGHT);
  const pageBackground = isDark ? THEME.dark.background : THEME.light.background;
  const handleNewSession = React.useCallback(() => {
    haptics.tap();
    newSession();
  }, [newSession]);

  const loading = sessionsQuery.isLoading;
  const loadFailed = sessionsQuery.isError && !hasSessions;
  const emptyMessage = loadFailed
    ? 'Unable to load sessions. Pull to refresh.'
    : !hasSessions
      ? 'No sessions yet'
      : 'No matching sessions';

  const menuStatus = menuSession ? sessionDisplayStatus(menuSession) : null;
  const canManageLifecycle = menuSession?.can_manage_lifecycle !== false;
  const canManageSharing = menuSession?.can_manage_sharing !== false;

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
                inputProps={{ accessibilityLabel: 'Search sessions' }}
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

      {/* Session options: `KortixBottomSheetModal`, no close button. It opens at
          its content height and drags up to full height (the `100%` stop).
          Rename and Share push in place of the options (`sheet-push`). */}
      <KortixBottomSheetModal
        ref={actionSheetRef}
        enableDynamicSizing
        snapPoints={OPTIONS_SHEET_SNAP_POINTS}
        topInset={insets.top}
        enablePanDownToClose
        onDismiss={handleSheetDismiss}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize">
        {/* One scrollable child: dynamic sizing needs it, and Share's member list
            can be taller than the screen. */}
        <BottomSheetScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
          {!menuSession ? null : sheetView === 'options' ? (
            <Animated.View key="options" entering={returning ? POP_IN : undefined}>
              <SheetTitleRow title={sessionDisplayTitle(menuSession)} hideClose />
              {/* The actions sit on the 16pt project edge, the title row's inset. */}
              <View className="px-4">
                <SettingsGroup>
                  <SettingsRow icon={Pencil} label="Rename" onPress={() => pushView('rename')} />
                  {canManageSharing ? (
                    <SettingsRow icon={Share} label="Share" onPress={() => pushView('share')} />
                  ) : null}
                  {canManageLifecycle ? (
                    <SettingsRow
                      icon={RotateCcw}
                      label="Restart"
                      right={null}
                      onPress={handleRestart}
                    />
                  ) : null}
                  {canManageLifecycle && menuStatus === 'running' ? (
                    <SettingsRow icon={Square} label="Stop" right={null} onPress={handleStop} />
                  ) : null}
                  {canManageLifecycle ? (
                    <SettingsRow
                      icon={Trash2}
                      label="Delete"
                      destructive
                      right={null}
                      onPress={() => {
                        haptics.warning();
                        deleteAfterCloseRef.current = true;
                        closeSheet();
                      }}
                    />
                  ) : null}
                </SettingsGroup>
              </View>
            </Animated.View>
          ) : (
            // Rename and Share push in place of the options; Back returns to them.
            <Animated.View key={sheetView} entering={PUSH_IN}>
              <SheetTitleRow
                title={PUSHED_VIEW_TITLE[sheetView]}
                leading={<SheetBackButton onPress={popView} />}
              />
              {sheetView === 'rename' ? (
                <SessionRenameForm
                  projectId={projectId}
                  session={liveRow(menuSession)}
                  onDone={closeSheet}
                />
              ) : (
                <SessionShareForm
                  projectId={projectId}
                  session={liveRow(menuSession)}
                  onDone={closeSheet}
                />
              )}
            </Animated.View>
          )}
        </BottomSheetScrollView>
      </KortixBottomSheetModal>

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

      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(open) => {
          // Keep the dialog up until an in-flight delete settles.
          if (!open && !deleteSession.isPending) setConfirmDelete(null);
        }}>
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete session</AlertDialogTitle>
            <AlertDialogDescription className={deleteFailed ? 'text-destructive' : undefined}>
              {deleteFailed
                ? 'Unable to delete. Check your connection and try again.'
                : `Delete “${deleteTitle}”? Its sandbox is destroyed. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild disabled={deleteSession.isPending}>
              <Button variant="secondary" size="lg" className="rounded-full">
                <Text>Cancel</Text>
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              size="lg"
              className="rounded-full"
              disabled={deleteSession.isPending}
              onPress={confirmDeleteSession}>
              <Text>{deleteSession.isPending ? 'Deleting…' : 'Delete session'}</Text>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </View>
  );
}
