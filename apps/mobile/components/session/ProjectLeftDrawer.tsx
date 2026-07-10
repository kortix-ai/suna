/**
 * ProjectLeftDrawer — the self-contained left drawer for the project screen.
 *
 * Lifted verbatim out of ProjectScreenLegacy.tsx (Task 6). It owns its own data
 * (project-sessions, kortix projects, OpenCode sessions, accounts) and mounts its
 * own two overlays (AccountMenuSheet + CommandPalette), so the screen that renders
 * it can stay small. The three private helpers (AnimatedCollapsible, AnimatedChevron,
 * ProjectSessionListItem) and SessionStatusDot are intentional duplicates of the
 * legacy copies; the duplication is resolved when Task 12 deletes the legacy file.
 *
 * The JSX below is legacy: raw Ionicons + inline `isDark ? '#hex' : '#hex'` colors.
 * That is preserved as-is on purpose — a token/primitive reskin is out of scope here.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Animated,
  InteractionManager,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import { ChevronsUpDown } from 'lucide-react-native';
import Svg, { Circle } from 'react-native-svg';
import { chalkColors } from '@kortix/shared';

import { useAuthContext } from '@/contexts';
import { useSessions } from '@/lib/platform/hooks';
import { useProjectSessions, useAccounts } from '@/lib/projects/hooks';
import type { ProjectSession, ProjectSessionStatus } from '@/lib/projects/projects-client';
import { useKortixProjects, type KortixProject } from '@/lib/kortix';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useTabStore } from '@/stores/tab-store';
import { AccountMenuSheet } from '@/components/projects/AccountMenuSheet';
import { CommandPalette } from '@/components/session/CommandPalette';
import { LegacyChatsSection } from '@/components/menu/LegacyChatsSection';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { haptics } from '@/lib/haptics';
import { log } from '@/lib/logger';

// ─── Animated collapsible wrapper ────────────────────────────────────────────

function AnimatedCollapsible({
  expanded,
  children,
}: {
  expanded: boolean;
  children: React.ReactNode;
}) {
  const [contentHeight, setContentHeight] = useState(0);
  const anim = useRef(new Animated.Value(expanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: expanded ? 1 : 0,
      duration: 250,
      useNativeDriver: false,
    }).start();
  }, [expanded, anim]);

  const animatedHeight =
    contentHeight > 0
      ? anim.interpolate({
          inputRange: [0, 1],
          outputRange: [0, contentHeight],
        })
      : undefined;

  const opacity = anim.interpolate({
    inputRange: [0, 0.3, 1],
    outputRange: [0, 0, 1],
  });

  return (
    <View>
      {/* Hidden measurer — always present, unconstrained by animated height */}
      <View
        style={{ position: 'absolute', opacity: 0, zIndex: -1, left: 0, right: 0 }}
        pointerEvents="none"
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          if (h > 0 && h !== contentHeight) setContentHeight(h);
        }}>
        {children}
      </View>
      {/* Animated container */}
      <Animated.View style={{ height: animatedHeight, opacity, overflow: 'hidden' }}>
        {children}
      </Animated.View>
    </View>
  );
}

// ─── Animated chevron ───────────────────────────────────────────────────────

function AnimatedChevron({
  expanded,
  color,
  size = 16,
}: {
  expanded: boolean;
  color: string;
  size?: number;
}) {
  const rotation = useRef(new Animated.Value(expanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(rotation, {
      toValue: expanded ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [expanded, rotation]);

  const rotate = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['-90deg', '0deg'],
  });

  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Ionicons name="chevron-down" size={size} color={color} />
    </Animated.View>
  );
}

// ─── Session status dot (dependency of ProjectSessionListItem) ───────────────

const SESSION_STATUS_COLORS = {
  yellow: 'hsl(48, 100%, 40%)',
  green: 'hsl(135, 100%, 28.5%)',
  red: 'hsl(360, 85.3%, 62%)',
} as const;

function SessionStatusDot({ status }: { status: ProjectSessionStatus }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isProvisioning = status === 'queued' || status === 'branching' || status === 'provisioning';
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isProvisioning) {
      spin.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1000,
        useNativeDriver: true,
      })
    );
    animation.start();
    return () => animation.stop();
  }, [isProvisioning, spin]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const color = isProvisioning
    ? SESSION_STATUS_COLORS.yellow
    : status === 'running'
      ? SESSION_STATUS_COLORS.green
      : status === 'stopped'
        ? isDark
          ? '#999999'
          : '#6e6e6e'
        : status === 'completed'
          ? SESSION_STATUS_COLORS.green
          : SESSION_STATUS_COLORS.red;

  return (
    <View className="h-4 w-4 shrink-0 items-center justify-center">
      <Animated.View style={isProvisioning ? { transform: [{ rotate }] } : undefined}>
        <Svg height={16} width={16} viewBox="0 0 16 16">
          <Circle
            cx={8}
            cy={8}
            r={6.3}
            stroke={color}
            fill="none"
            strokeWidth={1.5}
            strokeDasharray="3 3.4"
          />
          {(isProvisioning || status === 'failed') && <Circle cx={8} cy={8} r={4} fill={color} />}
        </Svg>
      </Animated.View>
    </View>
  );
}

// ─── Session list item ───────────────────────────────────────────────────────

function ProjectSessionListItem({
  item,
  isActive,
  onPress,
}: {
  item: ProjectSession;
  isActive: boolean;
  onPress: (s: ProjectSession) => void;
}) {
  const title = item.name || item.branch_name || 'New session';

  return (
    <TouchableOpacity
      onPress={() => onPress(item)}
      className={`mb-1 rounded-2xl px-3 py-2.5 ${isActive ? 'bg-muted' : ''}`}
      activeOpacity={0.6}>
      <View className="flex-row items-center gap-2">
        <SessionStatusDot status={item.status} />
        <Text
          className={`flex-1 text-sm ${isActive ? 'font-semibold text-foreground' : 'text-foreground'}`}
          numberOfLines={1}>
          {title}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// ─── ProjectLeftDrawer ───────────────────────────────────────────────────────

export interface ProjectLeftDrawerProps {
  projectId: string;
  /** The Kortix project-session row id currently open, for the active-row highlight. */
  activeProjectSessionId: string | null;
  /** Sandbox url of the open session, or undefined on project home. Gates the
   *  projects tree and the command palette's sandbox-scoped search, exactly as
   *  the legacy screen did. */
  sessionSandboxUrl?: string;
  onNewSession: () => void;
  onOpenProjectSession: (session: ProjectSession) => void;
  /** Close the drawer. Every row calls this before navigating. */
  onClose: () => void;
}

export function ProjectLeftDrawer({
  projectId,
  activeProjectSessionId,
  sessionSandboxUrl,
  onNewSession,
  onOpenProjectSession,
  onClose,
}: ProjectLeftDrawerProps): React.ReactElement {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  // ── Data the drawer owns ──
  const { data: projectSessions = [], isLoading: projectSessionsLoading } =
    useProjectSessions(projectId);
  const { data: kortixProjects } = useKortixProjects(sessionSandboxUrl);
  const sortedProjects = useMemo(() => {
    if (!kortixProjects || !Array.isArray(kortixProjects)) return [];
    return [...kortixProjects].sort(
      (a: KortixProject, b: KortixProject) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }, [kortixProjects]);
  // The OpenCode session list the command palette receives — a different list
  // from the Kortix project-session rows the drawer lists above.
  const { data: sessions = [] } = useSessions(sessionSandboxUrl);

  // ── Collapsible section state ──
  const [sessionsExpanded, setSessionsExpanded] = useState(true);
  const [projectsExpanded, setProjectsExpanded] = useState(false);

  // ── Overlays this drawer mounts ──
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ── User / account ──
  const hasUpdate = false;
  const { user, signOut, isSigningOut } = useAuthContext();
  const userEmail = user?.email || '';
  const userDisplayName = userEmail.split('@')[0] || 'User';
  const userChalk = useMemo(() => chalkColors(userDisplayName), [userDisplayName]);
  const planLabel = 'Self-Hosted';
  const accountsQuery = useAccounts(!!user);
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const activeAccount =
    accountsQuery.data?.find((a) => a.account_id === selectedAccountId) ??
    accountsQuery.data?.[0] ??
    null;

  // ── Handlers ──
  const handleOpenProjectSession = useCallback(
    (s: ProjectSession) => {
      onClose();
      onOpenProjectSession(s);
    },
    [onClose, onOpenProjectSession]
  );

  const handleNewSession = useCallback(() => {
    onClose();
    onNewSession();
  }, [onClose, onNewSession]);

  const goToProjects = useCallback(() => {
    haptics.tap();
    onClose();
    router.dismissTo('/projects');
  }, [onClose, router]);

  const handleProjectPress = useCallback(
    (project: KortixProject) => {
      const pageId = `page:project:${project.id}`;
      useTabStore.getState().setTabState(pageId, { projectName: project.name });
      useTabStore.getState().navigateToPage(pageId);
      onClose();
    },
    [onClose]
  );

  const handleUserMenuOpen = useCallback(() => {
    onClose();
    InteractionManager.runAfterInteractions(() => {
      setAccountMenuOpen(true);
    });
  }, [onClose]);

  const handleSignOut = useCallback(() => {
    if (isSigningOut) return;
    Alert.alert('Sign out', 'Sign out of Kortix?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          try {
            setAccountMenuOpen(false);
            onClose();
            await signOut();
          } catch (err: any) {
            log.error('❌ [Home] Sign out failed:', err?.message || err);
          }
        },
      },
    ]);
  }, [signOut, isSigningOut, onClose]);

  const iconColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#999999' : '#6e6e6e';

  return (
    <>
      <View className="flex-1 bg-chrome-background" style={{ paddingTop: insets.top }}>
        {/* Kortix wordmark — tap to go back to the projects list */}
        <View className="flex-row items-center justify-between px-5 pb-4 pt-3">
          <TouchableOpacity
            onPress={goToProjects}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 12 }}>
            <KortixLogo variant="logomark" size={18} color={isDark ? 'dark' : 'light'} />
          </TouchableOpacity>
        </View>

        {/* Top-level actions: New session / Search / Projects */}
        <View className="mb-2 px-2">
          <TouchableOpacity
            onPress={() => {
              haptics.tap();
              handleNewSession();
            }}
            className="flex-row items-center rounded-lg px-3 py-2.5"
            activeOpacity={0.6}>
            <Ionicons name="create-outline" size={18} color={iconColor} />
            <Text className="ml-3 flex-1 text-sm font-medium text-foreground">New session</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              haptics.tap();
              onClose();
              setPaletteOpen(true);
            }}
            className="flex-row items-center rounded-lg px-3 py-2.5"
            activeOpacity={0.6}>
            <Ionicons name="search-outline" size={18} color={iconColor} />
            <Text className="ml-3 flex-1 text-sm font-medium text-foreground">Search</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={goToProjects}
            className="flex-row items-center rounded-lg px-3 py-2.5"
            activeOpacity={0.6}>
            <Ionicons name="albums-outline" size={18} color={iconColor} />
            <Text className="ml-3 flex-1 text-sm font-medium text-foreground">All projects</Text>
          </TouchableOpacity>
        </View>

        {/* Projects header (collapsible) — above Sessions, matches web sidebar */}
        {sortedProjects.length > 0 && (
          <>
            <View className="flex-row items-center justify-between px-5 py-2.5">
              <TouchableOpacity
                onPress={goToProjects}
                className="flex-1 flex-row items-center"
                activeOpacity={0.6}>
                <Ionicons name="folder-outline" size={18} color={iconColor} />
                <Text className="ml-3 text-sm font-medium text-foreground">Projects</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  haptics.selection();
                  setProjectsExpanded((v) => !v);
                }}
                className="flex-row items-center"
                activeOpacity={0.6}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <View className="mr-1 rounded-full bg-muted px-2 py-0.5">
                  <Text className="text-xs text-muted-foreground">{sortedProjects.length}</Text>
                </View>
                <AnimatedChevron expanded={projectsExpanded} color={mutedColor} size={16} />
              </TouchableOpacity>
            </View>

            <AnimatedCollapsible expanded={projectsExpanded}>
              <View className="px-2 pb-2">
                {sortedProjects.map((project: KortixProject) => (
                  <TouchableOpacity
                    key={project.id}
                    onPress={() => {
                      haptics.tap();
                      handleProjectPress(project);
                    }}
                    className="mb-0.5 flex-row items-center rounded-lg px-4 py-2"
                    activeOpacity={0.6}>
                    <Ionicons
                      name="folder-outline"
                      size={14}
                      color={mutedColor}
                      style={{ marginRight: 8 }}
                    />
                    <Text className="flex-1 text-sm text-muted-foreground" numberOfLines={1}>
                      {project.name}
                    </Text>
                    {(project.sessionCount ?? 0) > 0 && (
                      <Text className="ml-2 text-xs text-muted-foreground/50">
                        {project.sessionCount}
                      </Text>
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            </AnimatedCollapsible>
          </>
        )}

        {/* Sessions header (collapsible) */}
        <TouchableOpacity
          onPress={() => {
            haptics.selection();
            setSessionsExpanded((v) => !v);
          }}
          className="flex-row items-center justify-between px-5 py-2.5"
          activeOpacity={0.6}>
          <View className="flex-row items-center">
            <Ionicons name="list-outline" size={18} color={iconColor} />
            <Text className="ml-3 text-sm font-medium text-foreground">Sessions</Text>
          </View>
          <AnimatedChevron expanded={sessionsExpanded} color={mutedColor} size={16} />
        </TouchableOpacity>

        {/* Session list — the project's repo-first sessions */}
        <View style={{ flex: 1, minHeight: 0 }}>
          {projectSessionsLoading ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator size="small" color={mutedColor} />
            </View>
          ) : (
            <ScrollView
              className="flex-1"
              contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 20 }}>
              <AnimatedCollapsible expanded={sessionsExpanded}>
                {projectSessions.length === 0 ? (
                  <View className="items-center py-8">
                    <Text className="text-sm text-muted-foreground">No sessions yet</Text>
                  </View>
                ) : (
                  projectSessions.map((ps) => (
                    <ProjectSessionListItem
                      key={ps.session_id}
                      item={ps}
                      isActive={ps.session_id === activeProjectSessionId}
                      onPress={handleOpenProjectSession}
                    />
                  ))
                )}
              </AnimatedCollapsible>
            </ScrollView>
          )}
        </View>

        {/* Pinned footer — user menu must stay tappable above the session list */}
        <View style={{ flexShrink: 0 }}>
          {/* Previous Chats — pre-OpenCode threads with bulk-convert (matches web sidebar) */}
          <LegacyChatsSection iconColor={iconColor} mutedColor={mutedColor} isDark={isDark} />

          {/* Bottom: user info — card style matching desktop */}
          <View className="px-3 pt-2" style={{ paddingBottom: insets.bottom + 8 }}>
            <TouchableOpacity
              onPress={() => {
                haptics.tap();
                handleUserMenuOpen();
              }}
              activeOpacity={0.8}
              className="flex-row items-center rounded-xl border border-border"
              style={{
                height: 48,
                paddingHorizontal: 8,
                gap: 8,
                backgroundColor: isDark ? 'rgba(45, 45, 45, 0.4)' : 'rgba(229, 229, 229, 0.4)',
              }}>
              <View className="relative">
                <View
                  className="h-8 w-8 items-center justify-center rounded-lg border border-border"
                  style={{
                    backgroundColor: userChalk.background,
                    borderColor: userChalk.border,
                  }}>
                  <Text
                    className="text-xs font-semibold uppercase"
                    style={{ color: userChalk.foreground }}>
                    {userDisplayName.charAt(0)}
                  </Text>
                </View>
                {hasUpdate && (
                  <View className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-background bg-red-500" />
                )}
              </View>
              <View className="flex-1" style={{ gap: 2 }}>
                <Text
                  className="font-medium text-foreground"
                  style={{ fontSize: 13, lineHeight: 16 }}
                  numberOfLines={1}>
                  {userDisplayName}
                </Text>
                <Text
                  className="text-muted-foreground"
                  style={{ fontSize: 11, lineHeight: 14 }}
                  numberOfLines={1}>
                  {userEmail || planLabel}
                </Text>
              </View>
              <ChevronsUpDown size={14} color={mutedColor} />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {accountMenuOpen ? (
        <AccountMenuSheet
          open
          name={(user?.user_metadata?.full_name as string | undefined) ?? undefined}
          email={userEmail}
          accountName={activeAccount?.name}
          accountId={activeAccount?.account_id ?? null}
          isSigningOut={isSigningOut}
          onSignOut={handleSignOut}
          onClose={() => setAccountMenuOpen(false)}
        />
      ) : null}

      <CommandPalette
        visible={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={sessions}
        onNewSession={onNewSession}
        onSessionSelect={(id) => useTabStore.getState().navigateToSession(id || null)}
        onPageSelect={(pageId) => useTabStore.getState().navigateToPage(pageId)}
        onSettings={() => {
          setAccountMenuOpen(false);
          onClose();
          router.push('/(settings)');
        }}
        sandboxUrl={sessionSandboxUrl}
      />
    </>
  );
}
