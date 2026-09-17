/**
 * ProjectLeftDrawer — the project sidebar. It opens full width from every
 * project page (the hamburger, or an edge swipe on any project route).
 *
 * Top to bottom:
 * - Header row: Kortix logomark, not tappable. No close button: an edge
 *   swipe closes the drawer.
 * - Nav pills: Sessions (→ /projects/[id]/sessions), Files
 *   (→ /projects/[id]/files), All projects (→ Projects list).
 * - The project's 20 most recent sessions (status mark · title, newest
 *   activity first; the session on screen is highlighted), then Previous chats. This list scrolls. The Sessions
 *   pill opens the full list.
 * - Pinned bottom bar over a fade of the drawer surface: New session (large
 *   primary pill) · the user's profile photo (→ the Account page at
 *   /projects/[id]/account).
 *
 * Every action closes the drawer first. The Projects list opens only with
 * `router.replace('/projects')`: the project replaced the list when it
 * opened, so the list is not under it. Sessions, Files, and Account go
 * through `onNavigateRoute` (ProjectScreen): a push over project home, or a
 * replace of the screen that covers home, so the project stack stays one
 * screen deep (lib/session/project-stack). New session returns to project
 * home and pops a covering screen. A navigation guard ignores a second tap
 * while the drawer closes, so a double tap never navigates twice.
 *
 * Layout rules: apps/mobile/design.md → Project sidebar.
 */

import React, { useCallback, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { LinearGradient } from 'expo-linear-gradient';
import { CustomizeIcon } from '@/components/icons/customize-icon';
import {
  ChatsTeardropIcon,
  FoldersIcon,
  NavigationArrowIcon,
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
import { KortixLogo } from '@/components/kortix/KortixLogo';
import { LegacyChatsSection } from '@/components/menu/LegacyChatsSection';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import { ProfilePicture } from '@/components/settings/ProfilePicture';
import { useProfileEditor } from '@/hooks/useProfileEditor';
import { haptics } from '@/lib/haptics';
import { useProjectSessions } from '@/lib/projects/hooks';
import type { ProjectSession } from '@/lib/projects/projects-client';
import {
  PROJECT_ACCOUNT_ROUTE,
  PROJECT_FILES_ROUTE,
  PROJECT_SESSIONS_ROUTE,
  type ProjectDrawerRoute,
} from '@/lib/session/project-stack';
import {
  recentSessions,
  sessionDisplayStatus,
  sessionDisplayTitle,
  sessionStatusLabel,
} from '@/lib/session/session-list';
import { cn } from '@/lib/utils/index';
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
/** Sessions listed in the drawer. The Sessions pill opens the full list. */
const DRAWER_RECENT_SESSIONS = 20;
/** Drawer progress at or below this counts as closed (fully off screen). */
const DRAWER_CLOSED_PROGRESS = 0.01;

// ─── Session row ─────────────────────────────────────────────────────────────

function ProjectSessionListItem({
  item,
  active,
  onPress,
}: {
  item: ProjectSession;
  /** The session on screen: `bg-accent` at rest and the `selected` state. */
  active: boolean;
  onPress: (s: ProjectSession) => void;
}) {
  const title = sessionDisplayTitle(item);
  const status = sessionDisplayStatus(item);

  return (
    <Pressable
      onPress={() => onPress(item)}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${sessionStatusLabel(status)}`}
      accessibilityState={{ selected: active }}
      className={cn(
        'flex-row items-center gap-3 rounded-xl active:bg-foreground/5',
        'px-3 py-2',
        active && 'bg-accent'
      )}>
      <SessionStatusMark status={status} />
      <Text className="flex-1" numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

// ─── Nav pill ────────────────────────────────────────────────────────────────

function NavPill({
  icon,
  label,
  onPress,
}: {
  icon: AppIcon;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="flex-row items-center gap-3 rounded-full px-4 py-2.5 active:bg-foreground/5">
      <Icon as={icon} size={18} className="shrink-0 text-foreground" />
      <Text className="font-medium" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
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
  /** New session: open project home, whose composer starts the session. */
  onNewSession: () => void;
  onOpenProjectSession: (session: ProjectSession) => void;
  /** Sessions, Files, or Account: push over home, or replace the covering screen. */
  onNavigateRoute: (route: ProjectDrawerRoute) => void;
  /** Close the drawer. Every action calls this before it navigates. */
  onClose: () => void;
}

export function ProjectLeftDrawer({
  projectId,
  activeProjectSessionId = null,
  onNewSession,
  onOpenProjectSession,
  onNavigateRoute,
  onClose,
}: ProjectLeftDrawerProps): React.ReactElement {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  // The drawer stays mounted while a root screen (Billing, a settings page)
  // covers the project.
  // Poll for provisioning rows only while the project screen is focused.
  const isFocused = useIsFocused();
  const { data: projectSessions = [], isLoading: projectSessionsLoading } = useProjectSessions(
    projectId,
    { poll: isFocused }
  );
  const recent = useMemo(
    () => recentSessions(projectSessions, DRAWER_RECENT_SESSIONS),
    [projectSessions]
  );
  // The Account page's photo and name, so both surfaces show the same person.
  const profile = useProfileEditor();

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

  const goToProjects = useCallback(
    () => navigateOnce(() => router.replace('/projects')),
    [navigateOnce, router]
  );

  const goToSessions = useCallback(
    () => navigateOnce(() => onNavigateRoute(PROJECT_SESSIONS_ROUTE)),
    [navigateOnce, onNavigateRoute]
  );

  const goToFiles = useCallback(
    () => navigateOnce(() => onNavigateRoute(PROJECT_FILES_ROUTE)),
    [navigateOnce, onNavigateRoute]
  );

  const handleOpenProjectSession = useCallback(
    (session: ProjectSession) => {
      onClose();
      onOpenProjectSession(session);
    },
    [onClose, onOpenProjectSession]
  );

  const handleNewSession = useCallback(() => {
    haptics.tap();
    onClose();
    onNewSession();
  }, [onClose, onNewSession]);

  // The same Account page as the Account tab, inside the project stack, so
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
    // One straight left line at 20pt: the logo header is px-5; every row
    // (nav, sessions, Previous chats) is px-3 inside a px-2 column.
    <View className="flex-1 bg-chrome-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center px-5 py-2">
        <View
          className="h-11 justify-center"
          accessible
          accessibilityRole="image"
          accessibilityLabel="Kortix">
          <KortixLogo variant="logomark" size={18} color={isDark ? 'dark' : 'light'} />
        </View>
      </View>

      <View className="px-2 -mx-1 space-y-1">
        <NavPill icon={ChatsTeardropIcon} label="Sessions" onPress={goToSessions} />
        <NavPill icon={FoldersIcon} label="Files" onPress={goToFiles} />
        <NavPill icon={CustomizeIcon} label="All projects" onPress={goToProjects} />
      </View>

      <View className="flex-1">
        <Animated.ScrollView
          style={{ flex: 1 }}
          showsVerticalScrollIndicator={false}
          onScroll={onListScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingTop: 4, paddingBottom: listBottomPadding }}>
          <View className="px-2 -mx-1">
            {projectSessionsLoading ? (
              <View className="items-center py-8">
                <KortixLoader size="small" />
              </View>
            ) : recent.length === 0 ? (
              <Text variant="muted" className="px-3 py-2">
                No sessions yet
              </Text>
            ) : (
              recent.map((ps) => (
                <ProjectSessionListItem
                  key={ps.session_id}
                  item={ps}
                  active={ps.session_id === activeProjectSessionId}
                  onPress={handleOpenProjectSession}
                />
              ))
            )}
          </View>
          <View className="mt-2 px-2">
            <LegacyChatsSection iconColor={iconColor} mutedColor={mutedColor} isDark={isDark} />
          </View>
        </Animated.ScrollView>
        {/* Top fade: rows fade out under the nav pills instead of a hard edge. */}
        <Animated.View
          pointerEvents="none"
          style={[{ position: 'absolute', top: 0, left: 0, right: 0, height: LIST_TOP_FADE_HEIGHT }, topFadeStyle]}>
          <LinearGradient colors={topFadeColors} style={StyleSheet.absoluteFill} />
        </Animated.View>
      </View>

      {/* Pinned bottom bar: New session · avatar, over a fade of the drawer
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
          <Button size="lg" className="rounded-full" onPress={handleNewSession}>
            {/* Web's New session glyph (project-sidebar.tsx), flipped horizontally: tip up-right. */}
            <Icon as={NavigationArrowIcon} size={20} style={{ transform: [{ scaleX: -1 }] }} />
            <Text>New session</Text>
          </Button>
          <Pressable
            onPress={goToAccount}
            accessibilityRole="button"
            accessibilityLabel="Account"
            hitSlop={2}
            className="rounded-full active:opacity-70">
            <ProfilePicture
              imageUrl={profile.avatarUrl}
              size={BAR_CONTROL_HEIGHT / 4}
              fallbackText={profile.displayName}
            />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
