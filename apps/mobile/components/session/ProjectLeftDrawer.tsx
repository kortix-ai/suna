/**
 * ProjectLeftDrawer — the project sidebar. It opens full width from every
 * project page (the hamburger, or an edge swipe on any project route).
 *
 * Top to bottom:
 * - Switcher row (COR-124/COR-157, Task 4): the account avatar overlapped
 *   by the project tile, the project name, and "in <account>" below it. Tap calls
 *   `onOpenSwitcher`: ProjectScreen opens `ProjectSwitcherSheet` (mounted
 *   there once, beside the other project sheets) over the drawer — one
 *   project/account switcher, not a navigation.
 *   The drawer's own gear button is gone: the project Settings page is
 *   reached from Settings (drawer avatar) → project row.
 * - Nav rows: Search (→ Sessions, its search field auto-focused), Files
 *   (→ /projects/[id]/files), Review (→ the Review page, a trailing count
 *   pill while items wait). Connectors moved to project Settings → Customize
 *   (KRTX-249): a "Customize in the web app" hand-off sheet, not a drawer row.
 * - A muted "Sessions" label, then every session of the project, newest
 *   activity first (status mark · title; the session on screen is
 *   highlighted). A sub-agent session (one spawned by another session in the
 *   list, COR-162) nests directly under its coordinator, indented 16pt, with
 *   a 12pt branch mark (`ArrowElbowDownRightIcon`) BEFORE its status mark —
 *   both render (`flattenSessionGroups`, `lib/session/session-list.ts`).
 *   Then Previous
 *   chats. Pages of 50 load as the list nears its end; a pull refreshes it.
 *   Long press opens `SessionActionsSheet` (Rename, Share, Restart sandbox,
 *   Stop, Delete) over the drawer — the drawer stays open, the same
 *   exception the switcher row makes.
 * - Pinned bottom bar over a fade of the drawer surface: the user's profile
 *   photo in its plan's gradient ring (`PlanRingAvatar`; → the Account page at
 *   /projects/[id]/account) · New session (large primary pill).
 *
 * Every action closes the drawer first, except the switcher row: it opens a
 * sheet over the drawer, and only a pick inside that sheet closes the drawer.
 * Search, Files, and Review go through `onNavigateRoute` (ProjectScreen) or
 * `useTabStore.navigateToPage`: a push over project home, or a replace of the
 * screen that covers home, so the project stack stays one screen deep
 * (lib/session/project-stack). New session returns to project home and pops a
 * covering screen. A navigation guard ignores a second tap while the drawer
 * closes, so a double tap never navigates twice.
 *
 * Layout rules: apps/mobile/design.md → Project sidebar.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { LinearGradient } from 'expo-linear-gradient';
import {
  ArrowElbowDownRightIcon,
  CaretUpDownIcon,
  FoldersIcon,
  MagnifyingGlassIcon,
  NavigationArrowIcon,
  SealCheckIcon,
  type AppIcon,
} from '@/lib/icons';
import { useDrawerProgress } from 'react-native-drawer-layout';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PixelDeadFlower } from '@/components/kortix/PixelDeadFlower';
import { Avatar } from '@/components/kortix/avatar';
import { LegacyChatsSection } from '@/components/menu/LegacyChatsSection';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import { PlanRingAvatar } from '@/components/settings/PlanRingAvatar';
import { useActivePlanName } from '@/hooks/useActivePlanName';
import { useProfileEditor } from '@/hooks/useProfileEditor';
import { haptics } from '@/lib/haptics';
import { useAccounts, useProject, useProjectSessionsPaged } from '@/lib/projects/hooks';
import { sessionListState, shouldLoadMoreSessions } from '@/lib/session/session-pages';
import type { ProjectSession } from '@/lib/projects/projects-client';
import {
  PROJECT_ACCOUNT_ROUTE,
  PROJECT_FILES_ROUTE,
  PROJECT_SESSIONS_ROUTE,
  type ProjectDrawerRoute,
} from '@/lib/session/project-stack';
import {
  flattenSessionGroups,
  recentSessions,
  sessionDisplayStatus,
  sessionDisplayTitle,
  sessionStatusLabel,
  type SessionListRow,
} from '@/lib/session/session-list';
import type { SessionNeedsYou } from '@/lib/session/needs-you';
import { useTabStore } from '@/stores/tab-store';
import { cn } from '@/lib/utils/index';
import { BUTTON_LABEL_MAX_FONT_SCALE } from '@/lib/ui/font-scale';
import { THEME, withAlpha } from '@/lib/utils/theme';

/** `Button size="lg"` height: the New session pill and the avatar match it. */
const BAR_CONTROL_HEIGHT = 44;
/** Gap between the bottom bar's controls and the safe-area edge. */
const BAR_BOTTOM_GAP = 16;
/** How far the bottom bar's fade reaches above its controls. */
const BAR_FADE_ABOVE = 36;
/** Space between the last scroll row and the bottom bar's controls. */
const LIST_END_GAP = 16;
/**
 * Height of the fade at the top of the session list. It also is the scroll
 * distance over which the fade appears: invisible at rest, so the first row is
 * never dimmed, fully shown once a row has scrolled under the pills.
 */
const LIST_TOP_FADE_HEIGHT = 24;
/** Drawer progress at or below this counts as closed (fully off screen). */
const DRAWER_CLOSED_PROGRESS = 0.01;

/**
 * The empty session list's art. The petal loop runs only while the drawer is
 * open: the drawer content stays mounted while closed. The visibility state
 * lives here, so opening the drawer re-renders this node only.
 */
function DrawerEmptyFlower({ color }: { color: string }) {
  const progress = useDrawerProgress();
  const [visible, setVisible] = useState(false);
  useAnimatedReaction(
    () => progress.value > DRAWER_CLOSED_PROGRESS,
    (next, prev) => {
      if (next !== prev) scheduleOnRN(setVisible, next);
    }
  );
  return <PixelDeadFlower color={color} animate={visible} />;
}

// ─── Session row ─────────────────────────────────────────────────────────────

/** Sub-agent sessions indent under their coordinator by this much (mobile's
 *  own stock-Tailwind spacing, not web's tighter `ml-4`). */
const NESTED_SESSION_INDENT = 16;

function ProjectSessionListItem({
  item,
  active,
  nested = false,
  needsYou,
  onPress,
  onLongPress,
}: {
  item: ProjectSession;
  /** What the session waits on (the Needs you group): a `needs-you` mark and a
   *  one-line reason under the title. */
  needsYou?: SessionNeedsYou;
  /** The session on screen: `bg-accent` at rest and the `selected` state. */
  active: boolean;
  /** A sub-agent session, rendered indented under its coordinator with a
   *  12pt branch mark before its status mark (both render). */
  nested?: boolean;
  onPress: (s: ProjectSession) => void;
  /** Opens the session actions sheet (Rename, Share, Restart, Stop, Delete). */
  onLongPress: (s: ProjectSession) => void;
}) {
  const title = sessionDisplayTitle(item);
  const status = sessionDisplayStatus(item, needsYou?.count ?? 0);
  const statusLabel = needsYou ? `${sessionStatusLabel(status)}, ${needsYou.reason}` : sessionStatusLabel(status);

  return (
    <Pressable
      onPress={() => onPress(item)}
      onLongPress={() => onLongPress(item)}
      accessibilityRole="button"
      accessibilityLabel={
        nested ? `${title}, sub-agent session, ${statusLabel}` : `${title}, ${statusLabel}`
      }
      accessibilityHint="Long press for session actions"
      accessibilityState={{ selected: active }}
      style={nested ? { marginLeft: NESTED_SESSION_INDENT } : undefined}
      className={cn(
        'flex-row items-center gap-3 rounded-xl active:bg-foreground/5',
        'px-4 py-2',
        active && 'bg-accent'
      )}>
      {nested && (
        <Icon as={ArrowElbowDownRightIcon} size={12} className="shrink-0 text-muted-foreground/60" />
      )}
      <SessionStatusMark status={status} />
      {needsYou ? (
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1}>{title}</Text>
          <Text variant="muted" style={{ fontSize: 13, lineHeight: 17 }} numberOfLines={1}>
            {needsYou.reason}
          </Text>
        </View>
      ) : (
        <Text className="flex-1" numberOfLines={1}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

// ─── Nav pill ────────────────────────────────────────────────────────────────

/**
 * One leading column for the drawer: nav pill icons sit in the same 20pt slot
 * as a session's `SessionStatusMark` (`h-5 min-w-5`), and both rows pad 16pt
 * (`px-4`), so every icon and status mark centres on one vertical line.
 */
const LEADING_SLOT_CLASS = 'w-5 shrink-0 items-center';

/**
 * One trailing column for the drawer's top rows: the switcher caret and
 * Review's count pill centre on the same vertical line. 28pt holds a
 * two-digit count; "99+" widens it by ~5pt.
 */
const TRAILING_SLOT_CLASS = 'min-w-7 shrink-0 items-center';

function NavPill({
  icon,
  label,
  onPress,
  trailing,
  accessibilityLabel,
}: {
  icon: AppIcon;
  label: string;
  onPress: () => void;
  /** A trailing count pill (Review). */
  trailing?: React.ReactNode;
  /** Overrides `label` for a screen reader (Review speaks its pending count). */
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      className="flex-row items-center gap-3 rounded-full px-4 py-2.5 active:bg-foreground/5">
      <View className={LEADING_SLOT_CLASS}>
        <Icon as={icon} size={18} className="text-foreground" />
      </View>
      <Text className="flex-1 font-medium" numberOfLines={1}>
        {label}
      </Text>
      {trailing ? <View className={TRAILING_SLOT_CLASS}>{trailing}</View> : null}
    </Pressable>
  );
}

/** Review's trailing count pill — the "needs-you" blue (`SessionStatusMark`), not web's amber. */
function ReviewCountPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View className="rounded-sm bg-kortix-blue/15 px-1.5 py-0.5">
      <Text className="font-roobert-medium text-xs text-kortix-blue">
        {count > 99 ? '99+' : String(count)}
      </Text>
    </View>
  );
}

// ─── Switcher row ────────────────────────────────────────────────────────────

function SwitcherRow({
  projectName,
  accountName,
  ringColor,
  onPress,
}: {
  projectName: string;
  accountName: string;
  /** The drawer surface colour: the ring that cuts the project tile out of the account avatar. */
  ringColor: string;
  onPress: () => void;
}) {
  const label = projectName && accountName ? `Switch project, ${projectName}, ${accountName}` : 'Switch project';
  return (
    // Avatar pair (Jay, 2026-09-24, Paper "Drawer header · variants" 16):
    // the account's round chalk avatar, overlapped by the project's chalk
    // tile — a 2pt ring in the drawer colour separates them — then the
    // project name over "in <account>", and a trailing up/down caret. No
    // fill at rest (in light mode `bg-card` equals the drawer surface, so a
    // fill never showed); `bg-secondary` pressed. One button edge to edge;
    // inner views ignore touches so every part presses it.
    <View className="px-1 pb-1">
      <Pressable
        onPress={onPress}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={label}
        className="flex-row items-center gap-3 rounded-full px-3 py-2 active:bg-foreground/5">
        <View pointerEvents="none" style={{ width: 62, height: 36 }}>
          <Avatar
            chalk
            size={34}
            fallbackText={accountName}
            style={{ position: 'absolute', left: 0, top: 1, borderRadius: 17 }}
          />
          <Avatar
            chalk
            size={36}
            fallbackText={projectName}
            style={{ position: 'absolute', left: 26, top: 0, borderWidth: 2, borderColor: ringColor }}
          />
        </View>
        <View pointerEvents="none" className="min-w-0 flex-1">
          <Text
            className="font-roobert-semibold text-foreground"
            style={{ fontSize: 17, lineHeight: 22, letterSpacing: -0.17 }}
            numberOfLines={1}>
            {projectName}
          </Text>
          {accountName ? (
            <Text variant="muted" style={{ fontSize: 13, lineHeight: 17 }} numberOfLines={1}>
              in {accountName}
            </Text>
          ) : null}
        </View>
        {/* mr-1: this row's content ends 4pt closer to the edge than a NavPill's (px-1 + px-3 vs px-2 -mx-1 + px-4). */}
        <View pointerEvents="none" className={cn(TRAILING_SLOT_CLASS, 'mr-1')}>
          <Icon as={CaretUpDownIcon} size={16} className="shrink-0 text-muted-foreground" />
        </View>
      </Pressable>
    </View>
  );
}

// ─── ProjectLeftDrawer ───────────────────────────────────────────────────────

export interface ProjectLeftDrawerProps {
  projectId: string;
  /**
   * The project session on screen (an open thread or a connecting session).
   * Its row is highlighted; tapping it only closes the drawer (ProjectScreen).
   */
  activeProjectSessionId?: string | null;
  /** Items that wait for the user — the Review row's trailing count pill. */
  reviewNeedsYouCount?: number;
  /**
   * Session id → what it waits on (`needsYouBySession` over the review inbox).
   * Those sessions leave the list for a "Needs you · N" group above it.
   */
  needsYouBySession?: ReadonlyMap<string, SessionNeedsYou>;
  /** New session: open project home, whose composer starts the session. */
  onNewSession: () => void;
  onOpenProjectSession: (session: ProjectSession) => void;
  /** Sessions, Files, or Account: push over home, or replace the covering screen. */
  onNavigateRoute: (route: ProjectDrawerRoute, routeParams?: Record<string, string>) => void;
  /**
   * Long press on a session row: opens `SessionActionsSheet` over the drawer
   * (COR-140 Task 5) — the drawer does not close for it, the same exception
   * the switcher row makes.
   */
  onSessionActions: (session: ProjectSession) => void;
  /**
   * The switcher row: open `ProjectSwitcherSheet` over the drawer. The drawer
   * stays open behind it; only a pick in the sheet closes the drawer.
   */
  onOpenSwitcher: () => void;
  /** Close the drawer. Every action calls this before it navigates. */
  onClose: () => void;
  /**
   * The drawer is open (false as soon as it starts to close). Its list
   * loaders draw only while it is open: a row tap closes the drawer over the
   * connecting session's loader, and one loader shows at a time (KRTX-244).
   */
  open: boolean;
}

const sessionRowKey = (row: SessionListRow) => row.session.session_id;
/** Shared empty map: a fresh one per render would re-derive the lists. */
const EMPTY_NEEDS_YOU: ReadonlyMap<string, SessionNeedsYou> = new Map();

export function ProjectLeftDrawer({
  projectId,
  activeProjectSessionId = null,
  reviewNeedsYouCount = 0,
  needsYouBySession = EMPTY_NEEDS_YOU,
  onNewSession,
  onOpenProjectSession,
  onNavigateRoute,
  onSessionActions,
  onOpenSwitcher,
  onClose,
  open,
}: ProjectLeftDrawerProps): React.ReactElement {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  // The drawer stays mounted while a root screen (Billing, a settings page)
  // covers the project.
  // Poll for provisioning rows only while the project screen is focused.
  const isFocused = useIsFocused();

  // The switcher row's project tile, name, and account line: the project's
  // own account, not necessarily the globally selected one — a deep link can
  // open a project in an account other than the one the user last picked.
  const { data: project } = useProject(projectId);
  const accountsQuery = useAccounts();
  const projectAccountId = project?.account_id ?? null;
  const projectAccountName =
    accountsQuery.data?.find((account) => account.account_id === projectAccountId)?.name ?? '';
  const openSwitcher = useCallback(() => {
    haptics.tap();
    onOpenSwitcher();
  }, [onOpenSwitcher]);
  // Every session of the project, a page (50) at a time: the list loads the
  // next page as it nears its end, and a pull refetches the loaded pages.
  const {
    sessions: projectSessions,
    isLoading: projectSessionsLoading,
    isError: projectSessionsErrored,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = useProjectSessionsPaged(projectId, { poll: isFocused });
  // Newest activity first, over every loaded row.
  const recent = useMemo(
    () => recentSessions(projectSessions, projectSessions.length),
    [projectSessions]
  );
  // A sub-agent session (spawned by another session in this list, see
  // `groupSessionsByCoordinator`) nests directly under its coordinator,
  // flattened for this `FlatList`. A coordinator not yet loaded (its page
  // hasn't arrived) leaves the child top-level until it does — see
  // `groupSessionsByCoordinator`'s doc comment.
  const rows = useMemo(
    () => flattenSessionGroups(recent.filter((session) => !needsYouBySession.has(session.session_id))),
    [recent, needsYouBySession]
  );
  // Sessions that wait on the user, newest wait first: their own group above
  // the list. A session not loaded yet (an older page) is left to the Review
  // row's count.
  const needsYouSessions = useMemo(
    () =>
      recent
        .filter((session) => needsYouBySession.has(session.session_id))
        .sort(
          (a, b) =>
            (needsYouBySession.get(b.session_id)?.newestAt ?? 0) -
            (needsYouBySession.get(a.session_id)?.newestAt ?? 0)
        ),
    [recent, needsYouBySession]
  );
  // loading / error / empty / rows — shared with the Sessions page
  // (lib/session/session-pages) so a failed fetch never reads as "No
  // sessions yet" (COR-146).
  const sessionsListState = sessionListState({
    isLoading: projectSessionsLoading,
    isError: projectSessionsErrored,
    hasSessions: rows.length > 0 || needsYouSessions.length > 0,
  });
  // Only a pull shows the refresh spinner; a background poll does not.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void refetch().finally(() => setRefreshing(false));
  }, [refetch]);
  const handleRetrySessions = useCallback(() => {
    haptics.tap();
    void refetch();
  }, [refetch]);
  const handleEndReached = useCallback(() => {
    if (shouldLoadMoreSessions({ hasNextPage, isFetchingNextPage, isRefreshing: refreshing })) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, refreshing, fetchNextPage]);
  // The Account page's photo and name, so both surfaces show the same person.
  const profile = useProfileEditor();
  // The avatar's ring colour.
  const planName = useActivePlanName();

  // The bar's controls sit 16pt above the safe-area edge (home indicator).
  const barBottom = insets.bottom + BAR_BOTTOM_GAP;
  // The fade starts BAR_FADE_ABOVE over the controls and reaches the screen edge.
  const fadeHeight = barBottom + BAR_CONTROL_HEIGHT + BAR_FADE_ABOVE;
  // The list scrolls under the fade; its last row must rest above the controls.
  const listBottomPadding = barBottom + BAR_CONTROL_HEIGHT + LIST_END_GAP;

  // Top fade: follows the scroll offset on the UI thread (no re-render per frame).
  const listScrollY = useSharedValue(0);
  const onListScroll = useAnimatedScrollHandler((event) => {
    listScrollY.value = event.contentOffset.y;
  });
  const topFadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(listScrollY.value, [0, LIST_TOP_FADE_HEIGHT], [0, 1], Extrapolation.CLAMP),
  }));

  // ── Navigation guard ──
  // A second tap on a pill before the drawer has closed would navigate a
  // second time. The first navigating tap sets the guard; it resets when the
  // drawer's visibility flips (fully closed, or visible again). The drawer
  // content stays mounted while closed, so the reset is driven by the
  // drawer's own progress value, not by mount or a timer.
  const navigatingRef = useRef(false);
  const progress = useDrawerProgress();
  const resetNavigating = useCallback(() => {
    navigatingRef.current = false;
  }, []);
  useAnimatedReaction(
    () => progress.value > DRAWER_CLOSED_PROGRESS,
    (visible, wasVisible) => {
      if (visible !== wasVisible) scheduleOnRN(resetNavigating);
    },
    [resetNavigating]
  );

  /** Close the drawer and navigate once. Later taps are ignored until reset. */
  const navigateOnce = useCallback(
    (navigate: () => void) => {
      if (navigatingRef.current) return;
      navigatingRef.current = true;
      haptics.tap();
      onClose();
      navigate();
    },
    [onClose]
  );

  // ── Handlers ──

  // Search opens the Sessions page with its search field already focused —
  // the drawer's only way to it now that the plain "Sessions" row is gone.
  const goToSearch = useCallback(
    () => navigateOnce(() => onNavigateRoute(PROJECT_SESSIONS_ROUTE, { autoFocusSearch: '1' })),
    [navigateOnce, onNavigateRoute]
  );

  const goToFiles = useCallback(
    () => navigateOnce(() => onNavigateRoute(PROJECT_FILES_ROUTE)),
    [navigateOnce, onNavigateRoute]
  );

  // Review is a tab-store page, not a drawer route: `navigateToPage` alone is
  // enough regardless of which project route is focused (ProjectScreen's old
  // gear button used the same call).
  const goToReview = useCallback(
    () => navigateOnce(() => useTabStore.getState().navigateToPage('page:review')),
    [navigateOnce]
  );

  const handleOpenProjectSession = useCallback(
    (session: ProjectSession) => {
      onClose();
      onOpenProjectSession(session);
    },
    [onClose, onOpenProjectSession]
  );

  const renderSession = useCallback(
    ({ item }: { item: SessionListRow }) => (
      <View className="px-2 -mx-1">
        <ProjectSessionListItem
          item={item.session}
          active={item.session.session_id === activeProjectSessionId}
          nested={item.nested}
          onPress={handleOpenProjectSession}
          onLongPress={onSessionActions}
        />
      </View>
    ),
    [activeProjectSessionId, handleOpenProjectSession, onSessionActions]
  );

  const handleNewSession = useCallback(() => {
    haptics.tap();
    onClose();
    onNewSession();
  }, [onClose, onNewSession]);

  // The app's one settings page (AccountPage), inside the project stack, so
  // its hamburger opens this drawer.
  const goToAccount = useCallback(
    () => navigateOnce(() => onNavigateRoute(PROJECT_ACCOUNT_ROUTE)),
    [navigateOnce, onNavigateRoute]
  );

  // LegacyChatsSection takes raw colours for its icons.
  const iconColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const mutedColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;

  // The drawer surface (bg-chrome-background), transparent → opaque, so rows
  // fade out under the bottom bar instead of stopping at a hard edge.
  const chrome = isDark ? THEME.dark.chromeBackground : THEME.light.chromeBackground;
  const fadeColors = [withAlpha(chrome, 0), withAlpha(chrome, 0.85), withAlpha(chrome, 1)] as const;
  // The same fade, reversed, where rows scroll up under the nav pills.
  const topFadeColors = [withAlpha(chrome, 1), withAlpha(chrome, 0)] as const;

  return (
    <>
    {/* One icon column: nav icons, session status marks, and the Previous
        Chats clock each sit in a 20pt slot starting 20pt from the drawer edge
        (centre 30pt, label 52pt). Nav and session rows are px-4 inside a
        4pt column (px-2 -mx-1); Previous Chats is px-3 inside px-2. */}
    <View className="flex-1 bg-chrome-background" style={{ paddingTop: insets.top }}>
      <SwitcherRow
        projectName={project?.name ?? ''}
        accountName={projectAccountName}
        ringColor={chrome}
        onPress={openSwitcher}
      />

      <View className="px-2 -mx-1 space-y-1">
        <NavPill icon={MagnifyingGlassIcon} label="Search" onPress={goToSearch} />
        <NavPill icon={FoldersIcon} label="Files" onPress={goToFiles} />
        <NavPill
          icon={SealCheckIcon}
          label="Review"
          accessibilityLabel={reviewNeedsYouCount > 0 ? `Review, ${reviewNeedsYouCount} pending` : 'Review'}
          onPress={goToReview}
          trailing={<ReviewCountPill count={reviewNeedsYouCount} />}
        />
      </View>

      {needsYouSessions.length > 0 && (
        <View className="px-2 -mx-1">
          <Text variant="muted" className="px-4 pb-1 pt-3">
            {`Needs you · ${needsYouSessions.length}`}
          </Text>
          {needsYouSessions.map((session) => (
            <ProjectSessionListItem
              key={session.session_id}
              item={session}
              active={session.session_id === activeProjectSessionId}
              needsYou={needsYouBySession.get(session.session_id)}
              onPress={handleOpenProjectSession}
              onLongPress={onSessionActions}
            />
          ))}
        </View>
      )}

      <View className="px-2 -mx-1">
        <Text variant="muted" className="px-4 pb-1 pt-3">
          Sessions
        </Text>
      </View>

      <View className="flex-1">
        <Animated.FlatList
          style={{ flex: 1 }}
          data={rows}
          keyExtractor={sessionRowKey}
          renderItem={renderSession}
          showsVerticalScrollIndicator={false}
          onScroll={onListScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingTop: 4, paddingBottom: listBottomPadding }}
          // Load the next page about one screen before the end of the list.
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.6}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={mutedColor} />
          }
          ListEmptyComponent={
            <View className="px-2 -mx-1">
              {sessionsListState === 'loading' ? (
                <View className="items-center py-8">
                  {open ? <KortixLoader size="small" /> : null}
                </View>
              ) : sessionsListState === 'error' ? (
                // The query failed and nothing survived to show — never
                // read this as "No sessions yet" (COR-146).
                <View className="items-center gap-2 px-3 py-6">
                  <Text variant="small" className="leading-5">
                    Couldn&apos;t load sessions
                  </Text>
                  <Text variant="muted" className="text-center">
                    Kortix didn&apos;t respond. Your sessions are safe.
                  </Text>
                  <View className="mt-1">
                    <Button variant="secondary" size="sm" className="rounded-full" onPress={handleRetrySessions}>
                      <Text maxFontSizeMultiplier={BUTTON_LABEL_MAX_FONT_SCALE.sm}>Try again</Text>
                    </Button>
                  </View>
                </View>
              ) : sessionsListState === 'empty' ? (
                <View
                  className="items-center py-8"
                  accessible
                  accessibilityRole="image"
                  accessibilityLabel="No sessions yet">
                  <DrawerEmptyFlower color={mutedColor} />
                </View>
              ) : null /* every session sits in the Needs you group */}
            </View>
          }
          ListFooterComponent={
            <View>
              {isFetchingNextPage && open ? (
                <View className="items-center py-4">
                  <KortixLoader size="small" />
                </View>
              ) : null}
              <View className="mt-2 px-2">
                <LegacyChatsSection iconColor={iconColor} mutedColor={mutedColor} isDark={isDark} />
              </View>
            </View>
          }
        />
        {/* Top fade: rows fade out under the nav pills instead of a hard edge. */}
        <Animated.View
          pointerEvents="none"
          style={[{ position: 'absolute', top: 0, left: 0, right: 0, height: LIST_TOP_FADE_HEIGHT }, topFadeStyle]}>
          <LinearGradient colors={topFadeColors} style={StyleSheet.absoluteFill} />
        </Animated.View>
      </View>

      {/* Pinned bottom bar: avatar · New session, over a fade of the drawer
          surface. Touches on the transparent top of the fade reach the rows. */}
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 bottom-0"
        style={{ height: fadeHeight }}>
        <LinearGradient
          pointerEvents="none"
          colors={fadeColors}
          locations={[0, 0.45, 1]}
          style={StyleSheet.absoluteFill}
        />
        <View
          pointerEvents="box-none"
          className="absolute inset-x-0 flex-row items-center justify-between px-5"
          style={{ bottom: barBottom }}>
          {/* Avatar left, New session right (Jay, 2026-09-23). The avatar
              wears its plan's gradient ring. */}
          <Pressable
            onPress={goToAccount}
            accessibilityRole="button"
            accessibilityLabel={planName ? `Account, ${planName} plan` : 'Account'}
            hitSlop={2}
            className="rounded-full active:opacity-70">
            <PlanRingAvatar
              imageUrl={profile.avatarUrl}
              fallbackText={profile.displayName}
              planName={planName}
              size={BAR_CONTROL_HEIGHT}
              gapColor={chrome}
            />
          </Pressable>
          <Button size="lg" className="rounded-full" onPress={handleNewSession}>
            {/* Web's New session glyph (project-sidebar.tsx), flipped horizontally: tip up-right. */}
            <Icon as={NavigationArrowIcon} size={20} style={{ transform: [{ scaleX: -1 }] }} />
            <Text maxFontSizeMultiplier={BUTTON_LABEL_MAX_FONT_SCALE.lg}>New session</Text>
          </Button>
        </View>
      </View>
    </View>
    </>
  );
}
