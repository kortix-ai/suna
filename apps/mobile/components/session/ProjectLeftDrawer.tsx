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
 * - Nav rows, the first rows of the scrolling list (they scroll away with
 *   it, so a new pill never shrinks the list): Search (→ Sessions, its search field auto-focused), Files
 *   (→ /projects/[id]/files), Review (→ the Review page, a trailing count
 *   pill while items wait), and Apps (→ the Apps page, the project's
 *   deployed apps). Connectors moved to project Settings → Customize
 *   (KRTX-249): a "Customize in the web app" hand-off sheet, not a drawer row.
 * - Three sections of top-level sessions, by who started the run (KRTX-639):
 *   "Sessions" (yours, open), "Shared" (other members', collapsed, no header
 *   while empty) and "Automated" (triggers, channels, API keys; collapsed).
 *   No section renders while the viewer's own list still loads.
 *   Each is its own paged query (`parent=root`), newest activity first
 *   (status mark · title; the session on screen is highlighted). A parent
 *   shows its child count and a caret, collapsed by default: a tap loads its
 *   children 20 at a time ("Show more"). The open session's parent starts
 *   open, and a child never renders without its parent
 *   (`buildDrawerItems`, lib/session/session-tree.ts). Shared and Automated
 *   rows name their starter under the title.
 *   A row whose root runtime session has sub-sessions (`directSubsessions`)
 *   shows their count after its title and ALWAYS lists them under its row,
 *   joined by a connector (`SubsessionTree`) — every such row, not only the
 *   session on screen. A sub-session row shows that sub-session: in place
 *   when its parent is the open thread, else it opens the parent first.
 *   Then Previous
 *   chats. Pages load as the list nears its end; a pull refreshes it.
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
  FoldersIcon,
  CaretDownIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
  SquaresFourIcon,
  NavigationArrowIcon,
  SealCheckIcon,
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
import { DrawerSessionNode, NESTED_SESSION_INDENT, useSessionStarterOf } from './DrawerSessionRows';
import { SubsessionTreeMemory } from '@/components/session/SessionSubsessionTree';
import { NavPill, ReviewCountPill, SwitcherRow } from './DrawerNavRows';
import { LegacyChatsSection } from '@/components/menu/LegacyChatsSection';
import { SessionChildren, type SessionChildrenProps } from '@/components/session/SessionTreeParts';
import { PlanRingAvatar } from '@/components/settings/PlanRingAvatar';
import { useActivePlanName } from '@/hooks/useActivePlanName';
import { useProfileEditor } from '@/hooks/useProfileEditor';
import { haptics } from '@/lib/haptics';
import { useRefetchOnOpen } from '@/components/session/use-refetch-on-open';
import { useAccounts, useProject, useProjectSessionsPaged } from '@/lib/projects/hooks';
import { sessionListState, shouldLoadMoreSessions } from '@/lib/session/session-pages';
import type { ProjectSession } from '@/lib/projects/projects-client';
import {
  PROJECT_ACCOUNT_ROUTE,
  PROJECT_FILES_ROUTE,
  PROJECT_SESSIONS_ROUTE,
  type ProjectDrawerRoute,
} from '@/lib/session/project-stack';
import { buildDrawerItems, isParentExpanded, rootRowsOnly, type DrawerItem, type DrawerSectionId } from '@/lib/session/session-tree';
import { parentKey, sectionKey, useSessionTreeStore } from '@/stores/session-tree-store';
import { useAuthContext } from '@/contexts';
import type { SessionNeedsYou } from '@/lib/session/needs-you';
import { useTabStore } from '@/stores/tab-store';
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
 * never dimmed, fully shown once a row has scrolled under the switcher row.
 */
const LIST_TOP_FADE_HEIGHT = 24;
/** The open refetch waits out the drawer's 420ms slide (`DRAWER_OPEN`). */
const DRAWER_REFETCH_DELAY_MS = 450;
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

/**
 * The drawer's `open`, for the children blocks' loaders. A context, not a
 * `renderItem` dependency: a drawer open or close then re-renders those
 * blocks only, not every list cell.
 */
const DrawerOpenContext = React.createContext(false);

function DrawerSessionChildren(props: Omit<SessionChildrenProps, 'showLoader'>) {
  const open = React.useContext(DrawerOpenContext);
  return <SessionChildren {...props} showLoader={open} />;
}

// ─── ProjectLeftDrawer ───────────────────────────────────────────────────────

export interface ProjectLeftDrawerProps {
  projectId: string;
  /**
   * The project session on screen (an open thread or a connecting session).
   * Its row is highlighted; tapping it only closes the drawer (ProjectScreen).
   */
  activeProjectSessionId?: string | null;
  /**
   * The runtime session id the open thread shows (tab store `activeSessionId`): the
   * root of `activeProjectSessionId`, or one of its sub-sessions. Null while
   * no thread is on screen. Picks which sub-session row is highlighted.
   */
  activeRuntimeSessionId?: string | null;
  /** The open session's parent (`sessionParentId`): that parent opens by default (KRTX-639). */
  activeParentSessionId?: string | null;
  /** Items that wait for the user — the Review row's trailing count pill. */
  reviewNeedsYouCount?: number;
  /**
   * Session id → what it waits on (`needsYouBySession` over the review inbox).
   * Those sessions leave the list for a "Needs you" group at its top, in the
   * same scroll (no count; Jay, 2026-09-27).
   */
  needsYouBySession?: ReadonlyMap<string, SessionNeedsYou>;
  /** New session: open project home, whose composer starts the session. */
  onNewSession: () => void;
  onOpenProjectSession: (session: ProjectSession) => void;
  /**
   * A sub-session row: show that runtime session — in place when its parent
   * is the open thread, else after opening the parent (ProjectScreen,
   * `drawerThreadMove`).
   */
  onOpenSubsession: (parent: ProjectSession, childId: string) => void;
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

const drawerItemKey = (item: DrawerItem) =>
  item.kind === 'header'
    ? `header:${item.section}`
    : item.kind === 'more'
      ? `more:${item.section}`
      : `${item.kind}:${item.session.session_id}`;
/** Automated and Shared page size: small, they load only to show a header or a first screen. */
const SIDE_SECTION_PAGE_SIZE = 20;
/** Shared empty map: a fresh one per render would re-derive the lists. */
const EMPTY_NEEDS_YOU: ReadonlyMap<string, SessionNeedsYou> = new Map();

/**
 * Memoized: ProjectScreen re-renders it on every poll and sheet change, and
 * its props are stable.
 */
export const ProjectLeftDrawer = React.memo(function ProjectLeftDrawer({
  projectId,
  activeProjectSessionId = null,
  activeRuntimeSessionId = null,
  activeParentSessionId = null,
  reviewNeedsYouCount = 0,
  needsYouBySession = EMPTY_NEEDS_YOU,
  onNewSession,
  onOpenProjectSession,
  onOpenSubsession,
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
  // KRTX-639: three independent paged queries of top-level sessions, by who
  // started the run. Children load per parent, on expand (`SessionChildren`).
  const viewerId = useAuthContext().user?.id ?? null;
  const starterOf = useSessionStarterOf(viewerId);
  const choices = useSessionTreeStore((state) => state.choices);
  const setChoice = useSessionTreeStore((state) => state.setChoice);
  const sectionOpen = (id: DrawerSectionId) => choices[sectionKey(projectId, id)] ?? id === 'sessions';
  const sharedOpen = sectionOpen('shared');
  const automatedOpen = sectionOpen('automated');
  // Polls only while the drawer is open: its content stays mounted while
  // closed, every poll result re-rendered it (~2 renders per 3 s), and the
  // open refetch below already shows a fresh list.
  const mine = useProjectSessionsPaged(projectId, { poll: isFocused && open, parent: 'root', startedBy: 'me' });
  // Shared loads always (its header hides when it is empty); Automated only
  // once opened: a project can hold hundreds of automated runs.
  const shared = useProjectSessionsPaged(projectId, {
    poll: false,
    parent: 'root',
    startedBy: 'others',
    limit: SIDE_SECTION_PAGE_SIZE,
  });
  const automated = useProjectSessionsPaged(projectId, {
    poll: false,
    parent: 'root',
    startedBy: 'automated',
    limit: SIDE_SECTION_PAGE_SIZE,
    enabled: automatedOpen,
  });
  const {
    isPending: projectSessionsPending,
    isError: projectSessionsErrored,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = mine;
  // The side sections' "Show more" rows. `fetchNextPage` is stable; the query
  // objects are new on every render, so the list reads these fields, not them.
  const sharedFetchingNext = shared.isFetchingNextPage;
  const automatedFetchingNext = automated.isFetchingNextPage;
  const fetchNextShared = shared.fetchNextPage;
  const fetchNextAutomated = automated.fetchNextPage;
  const mineRoots = useMemo(() => rootRowsOnly(mine.sessions), [mine.sessions]);
  const sharedRoots = useMemo(() => rootRowsOnly(shared.sessions), [shared.sessions]);
  const automatedRoots = useMemo(() => rootRowsOnly(automated.sessions), [automated.sessions]);
  // Depends on the `refetch` functions (stable), not the query objects (new on
  // every render): the callback must not change on each fetch's re-render.
  const refetchMine = mine.refetch;
  const refetchShared = shared.refetch;
  const refetchAutomated = automated.refetch;
  const refetchAll = useCallback(async () => {
    await Promise.all([
      refetchMine(),
      refetchShared(),
      automatedOpen ? refetchAutomated() : Promise.resolve(),
    ]);
  }, [refetchMine, refetchShared, refetchAutomated, automatedOpen]);
  // Sessions that wait on the user, newest wait first: their own group above
  // the list, from every loaded top-level row. A session not loaded yet (an
  // older page, a child) is left to the Review row's count.
  const needsYouSessions = useMemo(
    () =>
      [...mineRoots, ...sharedRoots, ...automatedRoots]
        .filter((session) => needsYouBySession.has(session.session_id))
        .sort(
          (a, b) =>
            (needsYouBySession.get(b.session_id)?.newestAt ?? 0) -
            (needsYouBySession.get(a.session_id)?.newestAt ?? 0)
        ),
    [mineRoots, sharedRoots, automatedRoots, needsYouBySession]
  );
  const withoutNeedsYou = useCallback(
    (rows: ProjectSession[]) => rows.filter((session) => !needsYouBySession.has(session.session_id)),
    [needsYouBySession]
  );
  const isExpanded = useCallback(
    (session: ProjectSession) =>
      isParentExpanded({
        explicit: choices[parentKey(projectId, session.session_id)],
        isActiveParent: session.session_id === activeParentSessionId,
        searchMatch: undefined,
      }),
    [choices, projectId, activeParentSessionId]
  );
  // While the viewer's own list loads, no section renders: Shared (a smaller
  // page, often first back) and Automated (always shown) read as an empty
  // drawer under the loader.
  const sessionsLoading = projectSessionsPending;
  const items = useMemo(
    () =>
      sessionsLoading
        ? []
        : buildDrawerItems(
            [
              {
                id: 'sessions',
                title: 'Sessions',
                rows: withoutNeedsYou(mineRoots),
                open: sectionOpen('sessions'),
                // No bare heading over nothing: the state block below (loading,
                // error, empty) speaks for an empty list, and Needs you for a
                // list whose every row waits on the user.
                hidden: withoutNeedsYou(mineRoots).length === 0,
                hasMore: hasNextPage,
              },
              {
                id: 'shared',
                title: 'Shared',
                rows: withoutNeedsYou(sharedRoots),
                open: sharedOpen,
                hidden: sharedRoots.length === 0,
                hasMore: shared.hasNextPage,
              },
              {
                id: 'automated',
                title: 'Automated',
                rows: withoutNeedsYou(automatedRoots),
                open: automatedOpen,
                hidden: false,
                hasMore: automated.hasNextPage,
              },
            ],
            isExpanded
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sectionOpen reads `choices`
    [sessionsLoading, mineRoots, sharedRoots, automatedRoots, withoutNeedsYou, sharedOpen, automatedOpen, choices, projectId, hasNextPage, shared.hasNextPage, automated.hasNextPage, isExpanded]
  );
  // loading / error / empty / rows — shared with the Sessions page
  // (lib/session/session-pages) so a failed fetch, or a first load paused
  // offline, never reads as "No sessions yet" (COR-146). Judged on the
  // viewer's own list; Shared and Automated add rows, never a verdict.
  const sessionsListState = sessionListState({
    isPending: projectSessionsPending,
    isError: projectSessionsErrored,
    hasSessions: mineRoots.length > 0 || sharedRoots.length > 0 || automatedRoots.length > 0,
  });
  // Only a pull shows the refresh spinner; a background poll does not.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void refetchAll().finally(() => setRefreshing(false));
  }, [refetchAll]);
  // The drawer stays mounted while closed, so its query never remounts: each
  // open refetches the loaded pages in the background (no spinner), so a
  // session created or renamed elsewhere shows without a pull. After the
  // slide (open is 420ms): a response landing mid-slide re-rendered the list
  // while it moved (Jay, 2026-09-27: "not smooth").
  useRefetchOnOpen(open, refetchAll, DRAWER_REFETCH_DELAY_MS);
  const handleRetrySessions = useCallback(() => {
    haptics.tap();
    void refetchAll();
  }, [refetchAll]);
  const handleEndReached = useCallback(() => {
    if (!sectionOpen('sessions')) return;
    if (shouldLoadMoreSessions({ hasNextPage, isFetchingNextPage, isRefreshing: refreshing })) {
      void fetchNextPage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sectionOpen reads `choices`
  }, [choices, projectId, hasNextPage, isFetchingNextPage, refreshing, fetchNextPage]);
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

  // Apps is a tab-store page like Review: one entry point, the drawer pill.
  const goToApps = useCallback(
    () => navigateOnce(() => useTabStore.getState().navigateToPage('page:apps')),
    [navigateOnce]
  );

  const handleOpenProjectSession = useCallback(
    (session: ProjectSession) => {
      onClose();
      onOpenProjectSession(session);
    },
    [onClose, onOpenProjectSession]
  );

  const handleOpenSubsession = useCallback(
    (parent: ProjectSession, childId: string) => {
      onClose();
      onOpenSubsession(parent, childId);
    },
    [onClose, onOpenSubsession]
  );

  const toggleParent = useCallback(
    (session: ProjectSession) =>
      setChoice(parentKey(projectId, session.session_id), !isExpanded(session)),
    [setChoice, projectId, isExpanded]
  );

  const renderChild = useCallback(
    (child: ProjectSession, trunkBelow: boolean) => (
      <DrawerSessionNode
        key={child.session_id}
        session={child}
        shown={child.session_id === activeProjectSessionId}
        activeRuntimeId={child.session_id === activeProjectSessionId ? activeRuntimeSessionId : null}
        nested
        trunkBelow={trunkBelow}
        onPress={handleOpenProjectSession}
        onLongPress={onSessionActions}
        onPressSubsession={handleOpenSubsession}
      />
    ),
    [activeProjectSessionId, activeRuntimeSessionId, handleOpenProjectSession, handleOpenSubsession, onSessionActions]
  );

  const renderItem = useCallback(
    ({ item }: { item: DrawerItem }) => {
      if (item.kind === 'header') {
        return (
          <Pressable
            onPress={() => {
              haptics.selection();
              setChoice(sectionKey(projectId, item.section), !item.open);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, ${item.open ? 'collapse' : 'expand'}`}
            accessibilityState={{ expanded: item.open }}
            className="flex-row items-center gap-1 px-2 -mx-1 pb-1 pt-3">
            <Text variant="muted" className="pl-4">
              {item.title}
            </Text>
            <Icon as={item.open ? CaretDownIcon : CaretRightIcon} size={12} className="text-muted-foreground" />
          </Pressable>
        );
      }
      if (item.kind === 'more') {
        const isShared = item.section === 'shared';
        const fetchingNext = isShared ? sharedFetchingNext : automatedFetchingNext;
        return (
          <View className="px-2 -mx-1 items-start pl-4">
            <Button
              variant="ghost"
              size="sm"
              disabled={fetchingNext}
              onPress={() => {
                haptics.tap();
                void (isShared ? fetchNextShared : fetchNextAutomated)();
              }}>
              <Text>{fetchingNext ? 'Loading…' : 'Show more'}</Text>
            </Button>
          </View>
        );
      }
      if (item.kind === 'children') {
        return (
          <View className="px-2 -mx-1">
            <DrawerSessionChildren
              projectId={projectId}
              parent={item.session}
              renderChild={renderChild}
              moreInset={NESTED_SESSION_INDENT}
            />
          </View>
        );
      }
      const shown = item.session.session_id === activeProjectSessionId;
      return (
        <View className="px-2 -mx-1">
          <DrawerSessionNode
            session={item.session}
            shown={shown}
            activeRuntimeId={shown ? activeRuntimeSessionId : null}
            starter={item.section === 'sessions' ? undefined : starterOf(item.session)}
            expanded={isExpanded(item.session)}
            onToggleChildren={toggleParent}
            onPress={handleOpenProjectSession}
            onLongPress={onSessionActions}
            onPressSubsession={handleOpenSubsession}
          />
        </View>
      );
    },
    [
      projectId,
      sharedFetchingNext,
      automatedFetchingNext,
      fetchNextShared,
      fetchNextAutomated,
      setChoice,
      renderChild,
      starterOf,
      isExpanded,
      toggleParent,
      activeProjectSessionId,
      activeRuntimeSessionId,
      handleOpenProjectSession,
      handleOpenSubsession,
      onSessionActions,
    ]
  );

  // Needs you scrolls WITH the list, as its header (Jay, 2026-09-27): above
  // it, 20 waiting sessions pushed the list off the screen and it could never
  // be reached. The loading / error / empty state of the viewer's own list
  // sits under it.
  const mutedColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const stateBlock = (
    <View className="px-2 -mx-1">
      {sessionsListState === 'loading' ? (
        <View className="items-center py-8">{open ? <KortixLoader size="small" /> : null}</View>
      ) : sessionsListState === 'error' ? (
        // The query failed and nothing survived to show — never read this as
        // "No sessions yet" (COR-146).
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
        <View className="items-center py-8" accessible accessibilityRole="image" accessibilityLabel="No sessions yet">
          <DrawerEmptyFlower color={mutedColor} />
        </View>
      ) : null}
    </View>
  );
  // The nav pills scroll with the list, as its first rows: pinned above it,
  // every new pill took list height away for good.
  const listHeader = useMemo(
    () => (
      <View>
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
          <NavPill icon={SquaresFourIcon} label="Apps" onPress={goToApps} />
        </View>
        {needsYouSessions.length > 0 ? (
          <View className="px-2 -mx-1">
            <Text variant="muted" className="px-4 pb-1 pt-3">
              Needs you
            </Text>
            {needsYouSessions.map((session) => (
              <DrawerSessionNode
                key={session.session_id}
                session={session}
                shown={session.session_id === activeProjectSessionId}
                activeRuntimeId={session.session_id === activeProjectSessionId ? activeRuntimeSessionId : null}
                needsYou={needsYouBySession.get(session.session_id)}
                onPress={handleOpenProjectSession}
                onLongPress={onSessionActions}
                onPressSubsession={handleOpenSubsession}
              />
            ))}
          </View>
        ) : null}
        {sessionsListState === 'rows' ? null : stateBlock}
      </View>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stateBlock is derived from the deps below
    [
      goToSearch,
      goToFiles,
      goToReview,
      goToApps,
      reviewNeedsYouCount,
      needsYouSessions,
      needsYouBySession,
      sessionsListState,
      open,
      mutedColor,
      handleRetrySessions,
      activeProjectSessionId,
      activeRuntimeSessionId,
      handleOpenProjectSession,
      onSessionActions,
      handleOpenSubsession,
    ]
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
  // Memoized: a new footer element re-renders Previous chats on every drawer render.
  const legacyChats = useMemo(
    () => (
      <View className="mt-2 px-2">
        <LegacyChatsSection iconColor={iconColor} mutedColor={mutedColor} isDark={isDark} />
      </View>
    ),
    [iconColor, mutedColor, isDark]
  );
  const showPageLoader = isFetchingNextPage && open;
  const listFooter = useMemo(
    () => (
      <View>
        {showPageLoader ? (
          <View className="items-center py-4">
            <KortixLoader size="small" />
          </View>
        ) : null}
        {legacyChats}
      </View>
    ),
    [showPageLoader, legacyChats]
  );

  // The drawer surface (bg-chrome-background), transparent → opaque, so rows
  // fade out under the bottom bar instead of stopping at a hard edge.
  const chrome = isDark ? THEME.dark.chromeBackground : THEME.light.chromeBackground;
  const fadeColors = [withAlpha(chrome, 0), withAlpha(chrome, 0.85), withAlpha(chrome, 1)] as const;
  // The same fade, reversed, where rows scroll up under the switcher row.
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

      <View className="flex-1">
        <DrawerOpenContext.Provider value={open}>
        {/* Expanded sub-session trees survive virtualisation; the drawer stays
            mounted, so they stay expanded while the project is open. */}
        <SubsessionTreeMemory>
        <Animated.FlatList
          style={{ flex: 1 }}
          data={items}
          keyExtractor={drawerItemKey}
          renderItem={renderItem}
          showsVerticalScrollIndicator={false}
          onScroll={onListScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingBottom: listBottomPadding }}
          ListHeaderComponent={listHeader}
          // Load the next page about one screen before the end of the list.
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.6}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={mutedColor} />
          }
          ListFooterComponent={listFooter}
        />
        </SubsessionTreeMemory>
        </DrawerOpenContext.Provider>
        {/* Top fade: rows fade out under the switcher row instead of a hard edge. */}
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
});
