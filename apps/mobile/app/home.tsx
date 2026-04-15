/**
 * Home — Main app screen for Kortix Computer Mobile.
 *
 * Uses a drawer layout:
 * - Drawer: Session list + "New Session" button
 * - Main: Either SessionPage (active session) or DashboardHome (new chat input)
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  FlatList,
  ScrollView,
  ActivityIndicator,
  Alert,
  Animated,
  Platform,
  StyleSheet,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Text } from '@/components/ui/text';
import { Stack, useRouter } from 'expo-router';
import { StatusBar as RNStatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { Drawer } from 'react-native-drawer-layout';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BottomSheetModal } from '@gorhom/bottom-sheet';

import { useAuthContext } from '@/contexts';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useSessions, useCreateSession, useDeleteSession, useArchiveSession, useUnarchiveSession } from '@/lib/platform/hooks';
import { useSyncStore } from '@/lib/opencode/sync-store';
import { getAuthToken } from '@/api/config';
import type { Session } from '@/lib/opencode/types';
import { SessionPage } from '@/components/session/SessionPage';
import { SessionChatInput, type PromptOptions, type TrackedMention } from '@/components/session/SessionChatInput';
import { BottomBar } from '@/components/session/BottomBar';
import type { BottomBarRef } from '@/components/session/BottomBar';
import { TabsOverview } from '@/components/session/TabsOverview';
import { CommandPalette } from '@/components/session/CommandPalette';
import {
  useOpenCodeAgents,
  useOpenCodeModels,
  useOpenCodeConfig,
} from '@/lib/opencode/hooks/use-opencode-data';
import { useResolvedConfig } from '@/lib/opencode/hooks/use-local-config';
import { useCompactSession } from '@/lib/opencode/hooks/use-compact-session';
import { useTabStore, PAGE_TABS } from '@/stores/tab-store';
import { RightDrawerContent } from '@/components/session/RightDrawerContent';
import { UserMenuSheet } from '@/components/session/UserMenuSheet';
import { ViewChangesSheet } from '@/components/session/ViewChangesSheet';
import { ExportTranscriptSheet } from '@/components/session/ExportTranscriptSheet';
import { ProjectsPage } from '@/components/pages/ProjectsPage';
import { ProjectDetailPage } from '@/components/pages/ProjectDetailPage';
import { useKortixProjects, type KortixProject } from '@/lib/kortix';
import { useGlobalSandboxUpdate } from '@/hooks/useSandboxUpdate';
import { PlaceholderPage } from '@/components/session/PlaceholderPage';
import { UpdatesPage } from '@/components/pages/UpdatesPage';
import { SSHPage } from '@/components/pages/SSHPage';
import { RunningServicesPage } from '@/components/pages/RunningServicesPage';
import { BrowserPage } from '@/components/pages/BrowserPage';
import { FilesPage } from '@/components/pages/FilesPage';
import { IntegrationsTabPage } from '@/components/pages/IntegrationsTabPage';
import { ScheduledTasksTabPage } from '@/components/pages/ScheduledTasksPage';
import { ApiKeysTabPage } from '@/components/pages/ApiKeysPage';
import { ChannelsTabPage } from '@/components/pages/ChannelsPage';
import { TunnelTabPage } from '@/components/pages/TunnelPage';
import { WorkspacePage, type WorkspacePageRef } from '@/components/pages/WorkspacePage';
import { AgentBrowserPage } from '@/components/pages/AgentBrowserPage';
import type { FilesPageRef } from '@/components/pages/FilesPage';
import { SecretsPage } from '@/components/pages/SecretsPage';
import { MemoryPage } from '@/components/pages/MemoryPage';
import { LlmProvidersPage } from '@/components/pages/LlmProvidersPage';
import { MarketplacePage } from '@/components/pages/MarketplacePage';
import { TerminalPage } from '@/components/pages/TerminalPage';
import { SetupWizard } from '@/components/setup/SetupWizard';
import { InstanceOnboarding } from '@/components/setup/InstanceOnboarding';
import { ProvisioningProgress } from '@/components/provisioning/ProvisioningProgress';
import { useSandboxPoller } from '@/lib/platform/use-sandbox-poller';
import {
  Eye, EyeOff, RefreshCw, Upload, Image, FolderPlus, LayoutGrid, List,
  FileText, Copy, Pencil, Trash2,
  Bot, Sparkles, Terminal, FolderOpen, Plug, Settings,
} from 'lucide-react-native';
import type { BottomBarMenuItem } from '@/components/session/BottomBar';
import { log } from '@/lib/logger';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { useTabScreenshotStore, validatePersistedScreenshots } from '@/stores/tab-screenshot-store';

// Safe import of react-native-view-shot — requires native rebuild.
// Returns null if the native module isn't available yet.
let captureRef: ((ref: any, opts?: any) => Promise<string>) | null = null;
let ViewShotComponent: React.ComponentType<any> | null = null;
try {
  const viewShot = require('react-native-view-shot');
  captureRef = viewShot.captureRef;
  ViewShotComponent = viewShot.default;
} catch {
  // Native module not available — screenshots disabled until rebuild
}

const THEME_PREFERENCE_KEY = '@theme_preference';
type ThemePreference = 'light' | 'dark' | 'system';

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

  const animatedHeight = contentHeight > 0
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
        }}
      >
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

function AnimatedChevron({ expanded, color, size = 16 }: { expanded: boolean; color: string; size?: number }) {
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

// ─── Connecting to Workspace (with restart button) ──────────────────────────
// Ported from web's connecting-screen.tsx (commits 345b805, a13fd57).
// Shows a restart button after 10s so users can recover a stuck sandbox.

function ConnectingToWorkspace({ isDark }: { isDark: boolean }) {
  const [showRestart, setShowRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Show restart button after 10 seconds of waiting
  useEffect(() => {
    const timer = setTimeout(() => setShowRestart(true), 10_000);
    return () => clearTimeout(timer);
  }, []);

  const handleRestart = useCallback(async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      const { restartSandbox } = await import('@/lib/platform/client');
      await restartSandbox();
      Alert.alert('Restarting', 'Machine restart initiated. Reconnecting…');
    } catch (err: any) {
      Alert.alert('Restart failed', err?.message || 'Unknown error');
    } finally {
      // Keep the button disabled for 15s so the sandbox has time to come back
      setTimeout(() => setRestarting(false), 15_000);
    }
  }, [restarting]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? '#09090b' : '#FFFFFF', paddingHorizontal: 40 }}>
      <View style={{ flexDirection: 'column', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <KortixLogo size={22} variant="symbol" color={isDark ? 'dark' : 'light'} />
        <Text style={{ fontSize: 13, fontFamily: 'Roobert', letterSpacing: 2, textTransform: 'uppercase', color: isDark ? 'rgba(248,248,248,0.3)' : 'rgba(18,18,21,0.3)' }}>
          Connecting to Workspace
        </Text>
      </View>
      <ActivityIndicator size="small" color={isDark ? '#ffffff' : '#000000'} />
      <Text style={{ marginTop: 24, fontSize: 14, fontFamily: 'Roobert', color: isDark ? 'rgba(248,248,248,0.4)' : 'rgba(18,18,21,0.4)', textAlign: 'center', lineHeight: 22, maxWidth: 300 }}>
        Checking sandbox health and restoring your session.
      </Text>

      {/* Restart button — appears after 10s of waiting (matches web) */}
      {showRestart && (
        <TouchableOpacity
          onPress={handleRestart}
          disabled={restarting}
          activeOpacity={0.7}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            marginTop: 20,
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 999,
            backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
            opacity: restarting ? 0.5 : 1,
          }}
        >
          <Ionicons
            name="refresh-outline"
            size={14}
            color={isDark ? 'rgba(248,248,248,0.6)' : 'rgba(18,18,21,0.5)'}
          />
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: isDark ? 'rgba(248,248,248,0.6)' : 'rgba(18,18,21,0.5)' }}>
            {restarting ? 'Restarting…' : 'Restart'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── Session list item (extracted to avoid re-renders) ──────────────────────

function SessionListItem({
  item,
  isActive,
  isChild = false,
  childCount = 0,
  isExpanded = false,
  onToggleExpand,
  onPress,
  onArchive,
  onDelete,
}: {
  item: Session;
  isActive: boolean;
  /** True when this row is rendered nested under a parent */
  isChild?: boolean;
  /** Total number of direct children — shows a persistent toggle pill */
  childCount?: number;
  /** Whether this row's children are currently expanded */
  isExpanded?: boolean;
  /** Toggle expand/collapse for this row's children */
  onToggleExpand?: () => void;
  onPress: (s: Session) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const mutedColor = isDark ? '#999999' : '#6e6e6e';
  const status = useSyncStore((s) => s.sessionStatus[item.id]);
  const isSessionBusy = status?.type === 'busy';

  return (
    <TouchableOpacity
      onPress={() => onPress(item)}
      onLongPress={() => {
        Alert.alert(item.title || 'Session', undefined, [
          { text: 'Archive', onPress: () => onArchive?.(item.id) },
          { text: 'Delete', style: 'destructive', onPress: () => onDelete?.(item.id) },
          { text: 'Cancel', style: 'cancel' },
        ]);
      }}
      className={`rounded-2xl px-3 py-2.5 mb-1 ${isActive ? 'bg-background' : ''}`}
      activeOpacity={0.6}
    >
      <View className="flex-row items-center">
        {isSessionBusy && (
          <View className="h-2 w-2 rounded-full bg-primary mr-2" />
        )}
        <Text
          className={`flex-1 text-sm ${
            isActive ? 'text-foreground font-semibold' : 'text-foreground'
          }`}
          numberOfLines={1}
        >
          {item.title || 'New Session'}
        </Text>

        {/* Child toggle pill — matches web f1aea74: persistent badge that stays
            visible so expanded sub-session lists can be collapsed again */}
        {childCount > 0 && onToggleExpand && (
          <TouchableOpacity
            onPress={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
            hitSlop={6}
            activeOpacity={0.6}
            accessibilityLabel={isExpanded ? 'Collapse sub-sessions' : 'Expand sub-sessions'}
            className={`ml-2 rounded-full px-2 py-0.5 ${
              isExpanded
                ? isDark ? 'bg-white/10' : 'bg-black/10'
                : isDark ? 'bg-white/[0.04]' : 'bg-black/[0.04]'
            }`}
          >
            <Text
              className={`text-[10px] ${
                isExpanded ? 'text-foreground' : 'text-muted-foreground'
              }`}
              style={{ fontVariant: ['tabular-nums'] }}
            >
              {childCount}
            </Text>
          </TouchableOpacity>
        )}

        {isActive && (
          <View className="flex-row items-center ml-2">
            <TouchableOpacity
              onPress={() => onArchive?.(item.id)}
              className="p-1.5 mr-0.5"
              hitSlop={6}
              activeOpacity={0.6}
            >
              <Ionicons name="archive-outline" size={16} color={mutedColor} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onDelete?.(item.id)}
              className="p-1.5"
              hitSlop={6}
              activeOpacity={0.6}
            >
              <Ionicons name="trash-outline" size={16} color={mutedColor} />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

/**
 * Build a map from parent session ID → array of child session IDs.
 * Ported from web's childMapByParent() in ui/turns.ts.
 */
function buildChildMap(sessions: Session[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const existing = map.get(session.parentID);
    if (existing) {
      existing.push(session.id);
    } else {
      map.set(session.parentID, [session.id]);
    }
  }
  return map;
}

/**
 * SessionGroup — renders a session row + its expanded children (recursive for nested trees).
 */
function SessionGroup({
  session,
  allSessions,
  childMap,
  expandedNodes,
  onToggleExpand,
  activeSessionId,
  onPress,
  onArchive,
  onDelete,
}: {
  session: Session;
  allSessions: Session[];
  childMap: Map<string, string[]>;
  expandedNodes: Record<string, boolean>;
  onToggleExpand: (sessionId: string) => void;
  activeSessionId: string | null;
  onPress: (s: Session) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const childIds = childMap.get(session.id);
  const hasChildren = !!childIds && childIds.length > 0;
  const isExpanded = expandedNodes[session.id] ?? false;

  const childSessions = useMemo(() => {
    if (!childIds) return [];
    return childIds
      .map((id) => allSessions.find((s) => s.id === id))
      .filter((s): s is Session => !!s)
      .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  }, [childIds, allSessions]);

  return (
    <View>
      <SessionListItem
        item={session}
        isActive={session.id === activeSessionId}
        isChild={false}
        childCount={hasChildren ? childSessions.length : 0}
        isExpanded={isExpanded}
        onToggleExpand={hasChildren ? () => onToggleExpand(session.id) : undefined}
        onPress={onPress}
        onArchive={onArchive}
        onDelete={onDelete}
      />

      {/* Expanded children — indented with a subtle left border */}
      {hasChildren && isExpanded && (
        <View
          className="ml-4 pl-2"
          style={{
            borderLeftWidth: 1,
            borderLeftColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
          }}
        >
          {childSessions.map((child) => {
            const grandchildIds = childMap.get(child.id);
            const hasGrandchildren = !!grandchildIds && grandchildIds.length > 0;

            // Recurse for grandchildren
            if (hasGrandchildren) {
              return (
                <SessionGroup
                  key={child.id}
                  session={child}
                  allSessions={allSessions}
                  childMap={childMap}
                  expandedNodes={expandedNodes}
                  onToggleExpand={onToggleExpand}
                  activeSessionId={activeSessionId}
                  onPress={onPress}
                  onArchive={onArchive}
                  onDelete={onDelete}
                />
              );
            }

            return (
              <SessionListItem
                key={child.id}
                item={child}
                isActive={child.id === activeSessionId}
                isChild
                onPress={onPress}
                onArchive={onArchive}
                onDelete={onDelete}
              />
            );
          })}
        </View>
      )}
    </View>
  );
}

// ─── Main screen ────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme, setColorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const router = useRouter();
  const {
    sandboxUrl, sandboxId, isLoading: sandboxLoading, error: sandboxError,
    isProvisioning, provisioningSandboxId, provisioningExternalId, provisioningProvider, onProvisioningComplete,
  } = useSandboxContext();

  // ── Provisioning progress poller ──
  const poller = useSandboxPoller({
    sandboxId: provisioningSandboxId,
    externalId: provisioningExternalId,
    provider: provisioningProvider,
    enabled: isProvisioning,
  });

  // When poller reaches 'ready', trigger refetch in sandbox context
  useEffect(() => {
    if (poller.status === 'ready') {
      onProvisioningComplete();
    }
  }, [poller.status, onProvisioningComplete]);

  // ── Instance setup wizard check ──
  // 'checking' = waiting for sandbox to be reachable, then checking env
  // 'needed'   = setup not complete, show wizard
  // 'done'     = setup complete, show main app
  const [setupState, setSetupState] = useState<'checking' | 'needed' | 'onboarding' | 'done'>('checking');

  useEffect(() => {
    if (!sandboxUrl) {
      log.log('[Home] Setup check: no sandboxUrl yet');
      return;
    }
    if (isProvisioning) {
      log.log('[Home] Setup check: sandbox still provisioning, waiting...');
      return;
    }
    log.log('[Home] Setup check: starting with sandboxUrl:', sandboxUrl);
    let cancelled = false;

    (async () => {
      // Check if we previously completed setup (persisted across app restarts).
      // If so, keep polling longer before showing wizard — the sandbox is likely
      // just booting and the env isn't populated yet.
      const SETUP_DONE_KEY = 'kortix-instance-setup-done';
      const wasSetupDone = (await AsyncStorage.getItem(SETUP_DONE_KEY)) === '1';
      const maxWaitMs = wasSetupDone ? 90_000 : 60_000;
      const pollMs = 3_000;
      const start = Date.now();

      // Poll the env endpoint until sandbox responds.
      let reachable = false;
      while (Date.now() - start < maxWaitMs && !cancelled) {
        try {
          const token = await getAuthToken();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const res = await fetch(`${sandboxUrl}/env/INSTANCE_SETUP_COMPLETE`, {
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: controller.signal,
          });
          clearTimeout(timeout);
          // 403 means the proxy is rejecting us (sandbox not authorized / not ready yet)
          // — don't treat as reachable, keep polling
          if (res.status === 403) {
            log.log('[Home] Setup check: got 403 (sandbox not authorized yet), keep polling...');
            await new Promise((r) => setTimeout(r, pollMs));
            continue;
          }
          // Any other HTTP response (even 404 for missing key) means sandbox is up
          reachable = true;
          if (cancelled) return;
          log.log('[Home] Setup check: sandbox reachable, INSTANCE_SETUP_COMPLETE response:', res.status);
          if (res.ok) {
            const data = await res.json();
            log.log('[Home] INSTANCE_SETUP_COMPLETE value:', data?.INSTANCE_SETUP_COMPLETE);
            if (data?.INSTANCE_SETUP_COMPLETE === 'true') {
              // Persist that setup is done so future boots show "Connecting" instead of wizard
              await AsyncStorage.setItem(SETUP_DONE_KEY, '1').catch(() => {});
              // Setup done — check if onboarding is also done.
              // Fix (ported from web e635de8): only enter onboarding on
              // POSITIVE evidence (200 response with value !== 'true').
              // On failure (5xx, network error) defer silently — the sandbox
              // is just slow, don't pop the onboarding wizard on users who
              // already completed it.
              try {
                const onbCtrl = new AbortController();
                const onbTimeout = setTimeout(() => onbCtrl.abort(), 5000);
                const onbRes = await fetch(`${sandboxUrl}/env/ONBOARDING_COMPLETE`, {
                  headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                  },
                  signal: onbCtrl.signal,
                });
                clearTimeout(onbTimeout);
                if (cancelled) return;
                if (onbRes.ok) {
                  const onbData = await onbRes.json();
                  if (onbData?.ONBOARDING_COMPLETE === 'true') {
                    setSetupState('done');
                    return;
                  }
                  // Positive evidence: 200 but not 'true' → needs onboarding
                  setSetupState('onboarding');
                  return;
                }
                // Non-200 (5xx, 403, etc.) — can't tell. Defer to main app.
                log.warn('[Home] ONBOARDING_COMPLETE returned', onbRes.status, '— deferring, not entering onboarding');
                setSetupState('done');
                return;
              } catch {
                // Network error — sandbox unreachable for this check.
                // Don't default to onboarding. Show main app and let
                // the user retry or wait for the sandbox to come back.
                log.warn('[Home] Failed to check ONBOARDING_COMPLETE — deferring, not entering onboarding');
                setSetupState('done');
                return;
              }
            }
          }
          // INSTANCE_SETUP_COMPLETE not 'true' yet.
          // If we previously completed setup, the sandbox is likely still booting
          // — keep polling instead of immediately showing the wizard.
          if (wasSetupDone) {
            log.log('[Home] Setup check: env not ready yet but setup was done before, keep polling...');
            await new Promise((r) => setTimeout(r, pollMs));
            continue;
          }
          // Fresh install — show setup wizard
          log.log('[Home] Setup check: INSTANCE_SETUP_COMPLETE not true, showing wizard');
          setSetupState('needed');
          return;
        } catch (err: any) {
          log.error('[Home] Setup check poll error:', err?.message || err);
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }

      if (cancelled) return;

      if (!reachable) {
        log.log('[Home] Setup check: sandbox not reachable after timeout');
        // If setup was done before, skip to main app (sandbox might come up later)
        if (wasSetupDone) {
          setSetupState('done');
        } else {
          setSetupState('needed');
        }
        return;
      }

      // Sandbox is reachable but env never returned 'true' after extended polling.
      // If setup was done before, go to main app — the sandbox just booted slowly.
      if (wasSetupDone) {
        log.log('[Home] Setup check: timed out but was previously set up — showing main app');
        setSetupState('done');
      } else {
        setSetupState('needed');
      }
    })();

    return () => { cancelled = true; };
  }, [sandboxUrl, isProvisioning]);

  const handleSetupComplete = useCallback(() => {
    // Persist that setup completed so we don't show wizard on next boot
    AsyncStorage.setItem('kortix-instance-setup-done', '1').catch(() => {});
    setSetupState('onboarding');
  }, []);

  const handleOnboardingComplete = useCallback(() => {
    setSetupState('done');
  }, []);

  // State
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const userMenuSheetRef = useRef<BottomSheetModal>(null);
  const viewChangesSheetRef = useRef<BottomSheetModal>(null);
  const exportTranscriptSheetRef = useRef<BottomSheetModal>(null);
  const [themePreference, setThemePreference] = useState<ThemePreference>('light');
  const { updateAvailable: hasUpdate } = useGlobalSandboxUpdate();

  // Files page ref (for BottomBar menu integration)
  const filesPageRef = useRef<FilesPageRef>(null);
  const workspacePageRef = useRef<WorkspacePageRef>(null);
  const bottomBarRef = useRef<BottomBarRef>(null);
  const viewShotRef = useRef<any>(null);
  const [filesShowHidden, setFilesShowHidden] = useState(false);
  const [filesViewMode, setFilesViewMode] = useState<'list' | 'grid'>('list');
  const [filesSelectedName, setFilesSelectedName] = useState<string | null>(null);
  const { user, signOut, isSigningOut } = useAuthContext();
  const userEmail = user?.email || '';
  const userDisplayName = userEmail.split('@')[0] || 'User';
  const planLabel = 'Self-Hosted';
  const sandboxLabel = sandboxId || 'Sandbox';
  const sandboxHost = sandboxUrl ? sandboxUrl.replace(/^https?:\/\//, '') : undefined;

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(THEME_PREFERENCE_KEY);
        if (!mounted) return;
        if (saved === 'light' || saved === 'dark' || saved === 'system') {
          setThemePreference(saved);
        } else {
          setThemePreference(colorScheme === 'dark' ? 'dark' : 'light');
        }
      } catch {
        if (mounted) {
          setThemePreference(colorScheme === 'dark' ? 'dark' : 'light');
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [colorScheme]);

  // Validate persisted tab screenshots (remove stale entries on startup)
  useEffect(() => { validatePersistedScreenshots(); }, []);

  // Compact session mutation
  const compactSession = useCompactSession();

  // Persisted tab state (survives app restarts)
  const activeSessionId = useTabStore((s) => s.activeSessionId);
  const activePageId = useTabStore((s) => s.activePageId);
  const showTabsOverview = useTabStore((s) => s.showTabsOverview);
  const openTabIds = useTabStore((s) => s.openTabIds);
  const openPageIds = useTabStore((s) => s.openPageIds);
  const sessionHistory = useTabStore((s) => s.sessionHistory);
  const historyIndex = useTabStore((s) => s.historyIndex);
  const navigateToSession = useTabStore((s) => s.navigateToSession);
  const closeTab = useTabStore((s) => s.closeTab);
  const closeAllTabs = useTabStore((s) => s.closeAllTabs);
  const setShowTabsOverview = useTabStore((s) => s.setShowTabsOverview);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < sessionHistory.length - 1;

  const handleHistoryBack = useCallback(() => {
    useTabStore.getState().goBack();
  }, []);

  const handleHistoryForward = useCallback(() => {
    useTabStore.getState().goForward();
  }, []);

  // Data
  const { data: sessions = [], isLoading: sessionsLoading } =
    useSessions(sandboxUrl);
  const { data: kortixProjects } = useKortixProjects(sandboxUrl);
  const sortedProjects = useMemo(() => {
    if (!kortixProjects || !Array.isArray(kortixProjects)) return [];
    return [...kortixProjects].sort(
      (a: KortixProject, b: KortixProject) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [kortixProjects]);
  const createSession = useCreateSession(sandboxUrl);
  const deleteSession = useDeleteSession(sandboxUrl);
  const archiveSession = useArchiveSession(sandboxUrl);
  const unarchiveSession = useUnarchiveSession(sandboxUrl);

  // Split sessions into active and archived
  const activeSessions = useMemo(
    () => sessions.filter((s) => !(s.time as any).archived),
    [sessions],
  );
  const archivedSessions = useMemo(
    () => sessions.filter((s) => !!(s.time as any).archived),
    [sessions],
  );

  // Collapsible state
  const [sessionsExpanded, setSessionsExpanded] = useState(true);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [expandedSessionNodes, setExpandedSessionNodes] = useState<Record<string, boolean>>({});

  const toggleSessionExpand = useCallback((sessionId: string) => {
    setExpandedSessionNodes((prev) => ({ ...prev, [sessionId]: !prev[sessionId] }));
  }, []);

  // Build parent→children map and derive the list of top-level (root) sessions.
  // Child sessions render nested under their parents when the parent is expanded.
  const { childMap, rootSessions } = useMemo(() => {
    const map = buildChildMap(activeSessions);
    const sessionIds = new Set(activeSessions.map((s) => s.id));
    const roots = activeSessions.filter((s) => !s.parentID || !sessionIds.has(s.parentID));
    return { childMap: map, rootSessions: roots };
  }, [activeSessions]);

  // Agent/model/variant for dashboard input
  const { data: agents = [] } = useOpenCodeAgents(sandboxUrl);
  const { data: dashVisibleModels = [], allModels: dashAllModels = [], defaults: dashDefaults } = useOpenCodeModels(sandboxUrl);
  const { data: dashConfig } = useOpenCodeConfig(sandboxUrl);
  const resolved = useResolvedConfig(agents, dashAllModels, dashConfig, dashDefaults);

  // Stable error message (prevents re-render loops from error object identity)
  const sandboxErrorMsg = sandboxError?.message || null;

  // Open file selected from command palette once Files page is active.
  useEffect(() => {
    if (!pendingFilePath) return;
    if (activePageId !== 'page:files') return;

    const timer = setTimeout(() => {
      filesPageRef.current?.openPath(pendingFilePath);
      setPendingFilePath(null);
    }, 120);

    return () => clearTimeout(timer);
  }, [pendingFilePath, activePageId]);

  // ── Handlers (all useCallback for stable refs) ──

  const handleDrawerOpen = useCallback(() => setDrawerOpen(true), []);
  const handleDrawerClose = useCallback(() => setDrawerOpen(false), []);
  const handleRightDrawerOpen = useCallback(() => setRightDrawerOpen(true), []);
  const handleRightDrawerClose = useCallback(() => setRightDrawerOpen(false), []);

  const handleNewSession = useCallback(async () => {
    if (!sandboxUrl) return;
    try {
      log.log('➕ [Home] Creating new session...');
      const session = await createSession.mutateAsync({});
      log.log('✅ [Home] Session created:', session.id);
      navigateToSession(session.id);
      setDrawerOpen(false);
    } catch (err: any) {
      log.error('❌ [Home] Failed to create session:', err?.message || err);
    }
  }, [sandboxUrl, createSession, navigateToSession]);

  const handleCreateSessionWithPrompt = useCallback(async (title: string, prompt: string) => {
    if (!sandboxUrl) return;
    try {
      const session = await createSession.mutateAsync({ title });
      navigateToSession(session.id);
      // Send the preset prompt into the new session
      const token = await getAuthToken();
      await fetch(`${sandboxUrl}/session/${session.id}/prompt_async`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }),
      });
    } catch (err: any) {
      log.error('❌ [Home] Failed to create session with prompt:', err?.message || err);
    }
  }, [sandboxUrl, createSession, navigateToSession]);

  const handleSessionPress = useCallback((session: Session) => {
    navigateToSession(session.id);
    setDrawerOpen(false);
  }, [navigateToSession]);

  const handleProjectPress = useCallback((project: KortixProject) => {
    const pageId = `page:project:${project.id}`;
    useTabStore.getState().setTabState(pageId, { projectName: project.name });
    useTabStore.getState().navigateToPage(pageId);
    setDrawerOpen(false);
  }, []);

  const handleBack = useCallback(() => navigateToSession(null), [navigateToSession]);

  const handleArchive = useCallback((sessionId: string) => {
    Alert.alert('Archive Session', 'Move this session to archived?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Archive',
        onPress: () => {
          if (useTabStore.getState().activeSessionId === sessionId) {
            navigateToSession(null);
          }
          archiveSession.mutate(sessionId);
        },
      },
    ]);
  }, [archiveSession, navigateToSession]);

  const handleUnarchive = useCallback((sessionId: string) => {
    unarchiveSession.mutate(sessionId);
  }, [unarchiveSession]);

  const handleDelete = useCallback((sessionId: string) => {
    Alert.alert('Delete Session', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          if (useTabStore.getState().activeSessionId === sessionId) {
            navigateToSession(null);
          }
          deleteSession.mutate(sessionId);
        },
      },
    ]);
  }, [deleteSession, navigateToSession]);

  // Simplified dashboard send flow (ported from web 3f150e0).
  // Single `isSending` guard, `finally` cleanup, parallel session create + fade.
  const [isDashboardSending, setIsDashboardSending] = useState(false);

  const handleDashboardSend = useCallback(
    async (text: string, options: PromptOptions, mentions?: TrackedMention[]) => {
      if (!sandboxUrl || isDashboardSending) return;
      if (!text.trim()) return;

      // Process session mentions — append XML refs
      let finalText = text;
      const sessionMentions = mentions?.filter((m) => m.kind === 'session' && m.value);
      if (sessionMentions && sessionMentions.length > 0) {
        const refs = sessionMentions
          .map((m) => `<session_ref id="${m.value}" title="${m.label}" />`)
          .join('\n');
        finalText = `${text}\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n${refs}`;
      }

      setIsDashboardSending(true);

      try {
        // Create session — navigate immediately on success
        const session = await createSession.mutateAsync({});
        navigateToSession(session.id);

        // Optimistic user message
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const partId = `prt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        useSyncStore.getState().addOptimisticMessage(session.id, {
          info: {
            id: messageId,
            role: 'user',
            sessionID: session.id,
            time: { created: Date.now() },
          },
          parts: [{ type: 'text', id: partId, text: finalText }],
        });
        useSyncStore.getState().setStatus(session.id, { type: 'busy' });

        // Fire prompt async (fire-and-forget)
        const payload: Record<string, any> = {
          parts: [{ type: 'text', text: finalText }],
        };
        if (options.model) payload.model = options.model;
        if (options.agent) payload.agent = options.agent;
        if (options.variant) payload.variant = options.variant;

        const token = await getAuthToken();
        fetch(`${sandboxUrl}/session/${session.id}/prompt_async`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
        }).catch((err) => {
          log.error('❌ [Home] Dashboard prompt failed:', err);
          useSyncStore.getState().setStatus(session.id, { type: 'idle' });
        });
      } catch (err: any) {
        log.error('❌ [Home] Dashboard send failed:', err?.message || err);
      } finally {
        setIsDashboardSending(false);
      }
    },
    [sandboxUrl, isDashboardSending, createSession, navigateToSession],
  );

  // Capture a screenshot of the current tab before showing tabs overview.
  // Screenshots are stored as temp files in the app's private directory —
  // they never appear in the user's photo gallery.
  const handleOpenTabsOverview = useCallback(async () => {
    const currentTabId = activePageId || activeSessionId;
    if (currentTabId && viewShotRef.current && captureRef) {
      try {
        const uri = await captureRef(viewShotRef, {
          format: 'jpg',
          quality: 0.6,
          result: 'tmpfile',
        });
        if (uri) {
          useTabScreenshotStore.getState().setScreenshot(currentTabId, uri);
        }
      } catch (err) {
        // Native module not available or capture failed — text preview fallback
      }
    }
    setShowTabsOverview(true);
  }, [activePageId, activeSessionId, setShowTabsOverview]);

  const closeUserMenuSheet = useCallback(() => {
    userMenuSheetRef.current?.dismiss();
  }, []);

  const handleGoToSettings = useCallback(() => {
    closeUserMenuSheet();
    setDrawerOpen(false);
    router.push('/(settings)');
  }, [closeUserMenuSheet, router]);

  const handleManageInstances = useCallback(() => {
    closeUserMenuSheet();
    setDrawerOpen(false);
    router.push('/(settings)/instances');
  }, [closeUserMenuSheet, router]);

  const handleAddInstance = useCallback(() => {
    closeUserMenuSheet();
    setDrawerOpen(false);
    router.push('/(settings)/instances');
  }, [closeUserMenuSheet, router]);

  const handleOpenChangelog = useCallback(() => {
    closeUserMenuSheet();
    setDrawerOpen(false);
    useTabStore.getState().navigateToPage('page:updates');
  }, [closeUserMenuSheet]);

  const handleThemeSelect = useCallback(async (value: ThemePreference) => {
    setThemePreference(value);
    try {
      await AsyncStorage.setItem(THEME_PREFERENCE_KEY, value);
    } catch {}
    setColorScheme(value === 'system' ? 'system' : value);
  }, [setColorScheme]);

  const handleUserMenuOpen = useCallback(() => {
    setDrawerOpen(false);
    setTimeout(() => {
      userMenuSheetRef.current?.present();
    }, 220);
  }, []);

  const handleSignOut = useCallback(() => {
    if (isSigningOut) return;
    Alert.alert(
      'Sign out',
      'Sign out of Kortix?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: async () => {
            try {
              closeUserMenuSheet();
              setDrawerOpen(false);
              await signOut();
            } catch (err: any) {
              log.error('❌ [Home] Sign out failed:', err?.message || err);
            }
          },
        },
      ],
    );
  }, [signOut, isSigningOut, closeUserMenuSheet]);

  // ── Drawer content ──

  const renderDrawerContent = useCallback(() => {
    const iconColor = isDark ? '#F8F8F8' : '#121215';
    const mutedColor = isDark ? '#999999' : '#6e6e6e';

    return (
      <View
        className="flex-1 bg-muted border-r border-border"
        style={{ paddingTop: insets.top }}
      >
        {/* Kortix wordmark */}
        <View className="flex-row items-center justify-between px-5 pt-3 pb-4">
          <KortixLogo variant="logomark" size={18} color={isDark ? 'dark' : 'light'} />
        </View>

        {/* Top-level actions: New session / Search / Files */}
        <View className="px-2 mb-2">
          <TouchableOpacity
            onPress={handleNewSession}
            className="flex-row items-center rounded-lg px-3 py-2.5"
            activeOpacity={0.6}
          >
            <Ionicons name="create-outline" size={18} color={iconColor} />
            <Text className="flex-1 text-sm font-medium ml-3 text-foreground">New session</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { setDrawerOpen(false); setCommandPaletteOpen(true); }}
            className="flex-row items-center rounded-lg px-3 py-2.5"
            activeOpacity={0.6}
          >
            <Ionicons name="search-outline" size={18} color={iconColor} />
            <Text className="flex-1 text-sm font-medium ml-3 text-foreground">Search</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              setDrawerOpen(false);
              useTabStore.getState().navigateToPage('page:files');
            }}
            className="flex-row items-center rounded-lg px-3 py-2.5"
            activeOpacity={0.6}
          >
            <Ionicons name="folder-outline" size={18} color={iconColor} />
            <Text className="flex-1 text-sm font-medium ml-3 text-foreground">Files</Text>
          </TouchableOpacity>
        </View>

        {/* Projects header (collapsible) — above Sessions, matches web sidebar */}
        {sortedProjects.length > 0 && (
          <>
            <TouchableOpacity
              onPress={() => setProjectsExpanded((v) => !v)}
              className="flex-row items-center justify-between px-5 py-2.5"
              activeOpacity={0.6}
            >
              <View className="flex-row items-center">
                <Ionicons name="folder-outline" size={18} color={iconColor} />
                <Text className="text-sm font-medium ml-3 text-foreground">Projects</Text>
              </View>
              <View className="flex-row items-center">
                <View className="bg-muted rounded-full px-2 py-0.5 mr-1">
                  <Text className="text-xs text-muted-foreground">{sortedProjects.length}</Text>
                </View>
                <AnimatedChevron expanded={projectsExpanded} color={mutedColor} size={16} />
              </View>
            </TouchableOpacity>

            <AnimatedCollapsible expanded={projectsExpanded}>
              <View className="px-2 pb-2">
                {sortedProjects.map((project: KortixProject) => (
                  <TouchableOpacity
                    key={project.id}
                    onPress={() => handleProjectPress(project)}
                    className="flex-row items-center rounded-lg px-4 py-2 mb-0.5"
                    activeOpacity={0.6}
                  >
                    <Ionicons name="folder-outline" size={14} color={mutedColor} style={{ marginRight: 8 }} />
                    <Text className="flex-1 text-sm text-muted-foreground" numberOfLines={1}>
                      {project.name}
                    </Text>
                    {(project.sessionCount ?? 0) > 0 && (
                      <Text className="text-xs text-muted-foreground/50 ml-2">
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
          onPress={() => setSessionsExpanded((v) => !v)}
          className="flex-row items-center justify-between px-5 py-2.5"
          activeOpacity={0.6}
        >
          <View className="flex-row items-center">
            <Ionicons name="list-outline" size={18} color={iconColor} />
            <Text className="text-sm font-medium ml-3 text-foreground">Sessions</Text>
          </View>
          <AnimatedChevron expanded={sessionsExpanded} color={mutedColor} size={16} />
        </TouchableOpacity>

        {/* Session list + Archived */}
        {sessionsLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="small" color={mutedColor} />
          </View>
        ) : (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 20 }}
          >
            <AnimatedCollapsible expanded={sessionsExpanded}>
              {/* Archived section (collapsible) */}
              {archivedSessions.length > 0 && (
                <>
                  <TouchableOpacity
                    onPress={() => setArchivedExpanded((v) => !v)}
                    className="flex-row items-center justify-between px-3 py-2.5"
                    activeOpacity={0.6}
                  >
                    <View className="flex-row items-center">
                      <Ionicons name="archive-outline" size={16} color={mutedColor} />
                      <Text className="text-sm ml-2 text-muted-foreground">Archived</Text>
                    </View>
                    <View className="flex-row items-center">
                      <View className="bg-muted rounded-full px-2 py-0.5 mr-1">
                        <Text className="text-xs text-muted-foreground">{archivedSessions.length}</Text>
                      </View>
                      <AnimatedChevron expanded={archivedExpanded} color={mutedColor} size={14} />
                    </View>
                  </TouchableOpacity>

                  <AnimatedCollapsible expanded={archivedExpanded}>
                    {archivedSessions.map((item) => (
                      <View key={item.id} className="flex-row items-center rounded-lg px-3 py-2.5 mb-0.5">
                        <Text
                          className="flex-1 text-sm text-muted-foreground"
                          numberOfLines={1}
                        >
                          {item.title || 'New Session'}
                        </Text>
                        <TouchableOpacity
                          onPress={() => handleUnarchive(item.id)}
                          className="p-1.5 mr-1"
                          hitSlop={6}
                          activeOpacity={0.6}
                        >
                          <Ionicons name="archive-outline" size={16} color={mutedColor} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleDelete(item.id)}
                          className="p-1.5"
                          hitSlop={6}
                          activeOpacity={0.6}
                        >
                          <Ionicons name="trash-outline" size={16} color={mutedColor} />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </AnimatedCollapsible>
                </>
              )}

              {/* Active sessions — parent/child tree (matches web f1aea74) */}
              {rootSessions.length === 0 ? (
                <View className="items-center py-8">
                  <Text className="text-sm text-muted-foreground">No sessions yet</Text>
                </View>
              ) : (
                rootSessions.map((item) => (
                  <SessionGroup
                    key={item.id}
                    session={item}
                    allSessions={activeSessions}
                    childMap={childMap}
                    expandedNodes={expandedSessionNodes}
                    onToggleExpand={toggleSessionExpand}
                    activeSessionId={activeSessionId}
                    onPress={handleSessionPress}
                    onArchive={handleArchive}
                    onDelete={handleDelete}
                  />
                ))
              )}
            </AnimatedCollapsible>
          </ScrollView>
        )}

        {/* Bottom: user info — card style matching desktop */}
        <View
          className="px-3 pt-2"
          style={{ paddingBottom: insets.bottom + 8 }}
        >
          <TouchableOpacity
            onPress={handleUserMenuOpen}
            activeOpacity={0.8}
            className="flex-row items-center rounded-xl border border-border bg-card px-2.5 py-2"
          >
            <View className="relative mr-3">
              <View className="h-9 w-9 rounded-full bg-muted items-center justify-center">
                <Text className="text-sm font-semibold text-muted-foreground uppercase">
                  {userDisplayName.charAt(0)}
                </Text>
              </View>
              {hasUpdate && (
                <View className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-red-500 border-2 border-background" />
              )}
            </View>
            <View className="flex-1">
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                {userDisplayName}
              </Text>
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {userEmail || planLabel}
              </Text>
            </View>
            <Ionicons name="chevron-expand-outline" size={16} color={mutedColor} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }, [
    isDark,
    insets,
    activeSessions,
    rootSessions,
    childMap,
    expandedSessionNodes,
    toggleSessionExpand,
    archivedSessions,
    sessionsLoading,
    sessionsExpanded,
    archivedExpanded,
    projectsExpanded,
    sortedProjects,
    handleProjectPress,
    activeSessionId,
    userDisplayName,
    userEmail,
    planLabel,
    hasUpdate,
    handleUserMenuOpen,
    handleNewSession,
    handleSessionPress,
    handleArchive,
    handleUnarchive,
    handleDelete,
  ]);

  const renderRightDrawerContent = useCallback(
    () => <RightDrawerContent onClose={handleRightDrawerClose} />,
    [handleRightDrawerClose],
  );

  // ── Render ──

  // Show provisioning progress when sandbox is being created
  if (isProvisioning) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <RNStatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
        <ProvisioningProgress
          progress={poller.progress}
          stages={poller.stages}
          currentStage={poller.currentStage}
          stageMessage={poller.stageMessage}
          machineInfo={poller.machineInfo}
          error={poller.error}
        />
      </>
    );
  }

  // Show loading screen while checking setup status — matches frontend's
  // "Connecting to Workspace" skeleton screen.
  // Includes a restart button that appears after a delay (ported from web 345b805 / a13fd57).
  if (setupState === 'checking') {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <RNStatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
        <ConnectingToWorkspace isDark={isDark} />
      </>
    );
  }

  // Show setup wizard if instance setup is not complete
  if (setupState === 'needed') {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <RNStatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
        <SetupWizard onComplete={handleSetupComplete} />
      </>
    );
  }

  // Show agent-driven onboarding after wizard completes
  if (setupState === 'onboarding') {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <RNStatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
        <InstanceOnboarding onComplete={handleOnboardingComplete} />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <RNStatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      <Drawer
        open={drawerOpen}
        onOpen={handleDrawerOpen}
        onClose={handleDrawerClose}
        drawerType="slide"
        drawerStyle={{
          width: '80%',
          backgroundColor: 'transparent',
          shadowColor: 'transparent',
          shadowOpacity: 0,
          shadowRadius: 0,
          shadowOffset: { width: 0, height: 0 },
          elevation: 0,
        }}
        overlayStyle={{ backgroundColor: 'transparent' }}
        swipeEnabled
        swipeEdgeWidth={80}
        swipeMinDistance={30}
        renderDrawerContent={renderDrawerContent}
      >
        <Drawer
          open={rightDrawerOpen}
          onOpen={handleRightDrawerOpen}
          onClose={handleRightDrawerClose}
          drawerPosition="right"
          drawerType="slide"
          drawerStyle={{
            width: '80%',
            backgroundColor: 'transparent',
            shadowColor: 'transparent',
            shadowOpacity: 0,
            shadowRadius: 0,
            shadowOffset: { width: 0, height: 0 },
            elevation: 0,
          }}
          overlayStyle={{ backgroundColor: 'transparent' }}
          swipeEnabled={false}
          renderDrawerContent={renderRightDrawerContent}
        >
        {React.createElement(
          ViewShotComponent || View,
          ViewShotComponent
            ? { ref: viewShotRef, style: { flex: 1, backgroundColor: isDark ? '#09090B' : '#FFFFFF' } }
            : { className: 'flex-1 bg-background' },
          <>
          {/* Loading sandbox */}
          {sandboxLoading ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator size="large" color={isDark ? '#999999' : '#6e6e6e'} />
              <Text className="text-sm mt-3 text-muted-foreground">
                Connecting to sandbox...
              </Text>
            </View>

          /* Sandbox error */
          ) : sandboxErrorMsg ? (
            <View className="flex-1 items-center justify-center px-8">
              <Text className="text-base font-medium mb-2 text-foreground">
                Connection Error
              </Text>
              <Text className="text-sm text-center text-muted-foreground">
                {sandboxErrorMsg}
              </Text>
            </View>

          /* Active page tab — Files */
          ) : activePageId === 'page:files' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <FilesPage
              ref={filesPageRef}
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
              onFileSelectionChange={(file) => setFilesSelectedName(file?.name ?? null)}
              onRequestMenu={() => bottomBarRef.current?.presentMenu()}
            />

          /* Active page tab — Memory */
          ) : activePageId === 'page:memory' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <MemoryPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — LLM Providers */
          ) : activePageId === 'page:llm-providers' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <LlmProvidersPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Secrets */
          ) : activePageId === 'page:secrets' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <SecretsPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Terminal */
          ) : activePageId === 'page:terminal' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <TerminalPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Marketplace */
          ) : activePageId === 'page:marketplace' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <MarketplacePage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Updates */
          ) : activePageId === 'page:updates' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <UpdatesPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — SSH */
          ) : activePageId === 'page:ssh' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <SSHPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Running Services */
          ) : activePageId === 'page:running-services' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <RunningServicesPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Browser */
          ) : activePageId === 'page:browser' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <BrowserPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Agent Browser */
          ) : activePageId === 'page:agent-browser' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <AgentBrowserPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Integrations */
          ) : activePageId === 'page:integrations' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <IntegrationsTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Triggers / Scheduled Tasks */
          ) : activePageId === 'page:triggers' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <ScheduledTasksTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — API Keys */
          ) : activePageId === 'page:api' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <ApiKeysTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Channels */
          ) : activePageId === 'page:channels' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <ChannelsTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Tunnel */
          ) : activePageId === 'page:tunnel' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <TunnelTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Workspace */
          ) : activePageId === 'page:workspace' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <WorkspacePage
              ref={workspacePageRef}
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
              onCreateSessionWithPrompt={handleCreateSessionWithPrompt}
            />

          /* Active page tab — Projects list */
          ) : activePageId === 'page:projects' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <ProjectsPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — Single project detail (dynamic: page:project:{id}) */
          ) : activePageId?.startsWith('page:project:') && !showTabsOverview ? (
            <ProjectDetailPage
              projectId={activePageId.replace('page:project:', '')}
              onBack={() => {
                // Go back to projects list
                useTabStore.getState().navigateToPage('page:projects');
              }}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active page tab — other pages (placeholder) */
          ) : activePageId && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <PlaceholderPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={handleDrawerOpen}
              onOpenRightDrawer={handleRightDrawerOpen}
            />

          /* Active session */
          ) : activeSessionId && !showTabsOverview ? (
            <SessionPage sessionId={activeSessionId} onBack={handleBack} onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen} onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen} isDrawerOpen={drawerOpen} isRightDrawerOpen={rightDrawerOpen} />

          /* Tabs overview */
          ) : showTabsOverview ? (
            <TabsOverview
              sessions={activeSessions}
              openTabIds={openTabIds}
              activeSessionId={activeSessionId}
              onSelectTab={(id) => navigateToSession(id)}
              onCloseTab={(id) => {
                closeTab(id);
                useTabScreenshotStore.getState().removeScreenshot(id);
              }}
              onCloseAll={() => {
                closeAllTabs();
                useTabScreenshotStore.getState().clear();
              }}
              onNewSession={handleNewSession}
              onDismiss={() => setShowTabsOverview(false)}
            />

          /* Dashboard */
          ) : (
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" className="bg-background">
              <View
                style={{ paddingTop: insets.top }}
                className="px-4 pb-3 bg-background"
              >
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center">
                    <TouchableOpacity
                      onPress={handleDrawerOpen}
                      className="mr-3 p-1"
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Ionicons name="menu" size={24} color={isDark ? '#F8F8F8' : '#121215'} />
                    </TouchableOpacity>
                    <Text className="text-lg font-bold text-foreground">
                      Kortix
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={handleRightDrawerOpen}
                    className="p-1"
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons name="apps-outline" size={20} color={isDark ? '#F8F8F8' : '#121215'} />
                  </TouchableOpacity>
                </View>
              </View>

              <Animated.View
                className="flex-1 items-center justify-center px-8"
                style={{ opacity: isDashboardSending ? 0.3 : 1 }}
              >
                <Text className="text-2xl font-bold mb-2 text-foreground">
                  What can I help with?
                </Text>
                <Text className="text-sm text-center text-muted-foreground">
                  Start a conversation or select a session from the menu.
                </Text>
              </Animated.View>

              <View>
                <SessionChatInput
                  onSend={handleDashboardSend}
                  placeholder="Ask anything..."
                  disabled={!sandboxUrl || isDashboardSending}
                  agent={resolved.agent}
                  agents={resolved.agents}
                  model={resolved.model}
                  models={dashVisibleModels}
                  modelKey={resolved.modelKey}
                  variant={resolved.variant}
                  variants={resolved.variants}
                  onAgentChange={resolved.setAgent}
                  onModelChange={resolved.setModel}
                  onVariantCycle={resolved.cycleVariant}
                  onVariantSet={resolved.setVariant}
                  sessions={sessions}
                  sandboxUrl={sandboxUrl}
                />
              </View>
            </KeyboardAvoidingView>
          )}

        </>
        )}

          {/* Bottom bar — hidden when tabs overview is showing */}
          {!showTabsOverview && (
            <View>
              <BottomBar
                ref={bottomBarRef}
                activeSessionId={activeSessionId}
                onMenuDismiss={() => {
                  if (activePageId === 'page:files') {
                    filesPageRef.current?.deselectFile();
                    setFilesSelectedName(null);
                  }
                }}
                tabCount={openTabIds.length + openPageIds.length}
                canGoBack={canGoBack}
                canGoForward={canGoForward}
                onBack={handleHistoryBack}
                onForward={handleHistoryForward}
                onNewSession={handleNewSession}
                onOpenTabs={handleOpenTabsOverview}
                onCompactSession={() => {
                  if (activeSessionId && sandboxUrl) {
                    Alert.alert(
                      'Compact Session',
                      'This will summarize older messages using AI to free up context space. Key information is preserved, but original messages will be condensed into a compact summary.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Compact',
                          onPress: () => {
                            compactSession.mutate(
                              { sandboxUrl, sessionId: activeSessionId },
                              {
                                onError: (err) => {
                                  Alert.alert('Compact Failed', err.message || 'Failed to compact session.');
                                },
                              },
                            );
                          },
                        },
                      ],
                    );
                  }
                }}
                onExportTranscript={() => {
                  if (activeSessionId) {
                    exportTranscriptSheetRef.current?.present();
                  }
                }}
                onViewChanges={() => {
                  if (activeSessionId) {
                    viewChangesSheetRef.current?.present();
                  }
                }}
                onDiagnostics={() => log.log('TODO: diagnostics')}
                onArchiveSession={() => { if (activeSessionId) handleArchive(activeSessionId); }}
                customMenuItems={
                  activePageId === 'page:workspace'
                    ? ([
                        {
                          icon: Bot,
                          label: 'New agent',
                          onPress: () => handleCreateSessionWithPrompt('New agent', "HEY let's build a new agent. Ask what job it should own, then scaffold it in the right workspace location and wire up any supporting skills."),
                        },
                        {
                          icon: Sparkles,
                          label: 'New skill',
                          onPress: () => handleCreateSessionWithPrompt('New skill', "HEY let's build a new skill. Ask what should trigger it, then create the SKILL.md and any supporting files in the right workspace location."),
                        },
                        {
                          icon: Terminal,
                          label: 'New command',
                          onPress: () => handleCreateSessionWithPrompt('New command', "HEY let's build a new slash command. Ask what the command should do, then add it in the right workspace location and connect it to the correct agent."),
                        },
                        {
                          icon: FolderOpen,
                          label: 'New project',
                          onPress: () => handleCreateSessionWithPrompt('New project', "HEY let's set up a new project. Ask for the name and purpose, then create it in the right workspace location with a clean starting structure."),
                        },
                        { type: 'divider' },
                        {
                          icon: Plug,
                          label: 'Add MCP server',
                          onPress: () => workspacePageRef.current?.openSettings('mcp'),
                        },
                        {
                          icon: Settings,
                          label: 'Settings',
                          onPress: () => workspacePageRef.current?.openSettings('general'),
                        },
                        { type: 'divider' },
                        {
                          icon: RefreshCw,
                          label: 'Refresh workspace',
                          onPress: () => workspacePageRef.current?.refetch(),
                        },
                      ] as BottomBarMenuItem[])
                    : activePageId === 'page:files'
                    ? (filesSelectedName
                        ? ([
                            // Contextual file actions only (long-press)
                            {
                              icon: FileText,
                              label: `Open ${filesSelectedName}`,
                              onPress: () => {
                                filesPageRef.current?.openFile();
                                setFilesSelectedName(null);
                              },
                            },
                            {
                              icon: Copy,
                              label: 'Copy path',
                              onPress: () => {
                                filesPageRef.current?.copyPath();
                                setFilesSelectedName(null);
                              },
                            },
                            {
                              icon: Pencil,
                              label: 'Rename',
                              onPress: () => filesPageRef.current?.renameFile(),
                            },
                            {
                              icon: Trash2,
                              label: 'Delete',
                              destructive: true,
                              onPress: () => filesPageRef.current?.deleteFile(),
                            },
                          ] as BottomBarMenuItem[])
                        : ([
                            // General file actions (three-dot tap)
                            {
                              icon: filesViewMode === 'list' ? LayoutGrid : List,
                              label: filesViewMode === 'list' ? 'Grid view' : 'List view',
                              onPress: () => {
                                filesPageRef.current?.toggleViewMode();
                                setFilesViewMode((v) => (v === 'list' ? 'grid' : 'list'));
                              },
                            },
                            {
                              icon: filesShowHidden ? Eye : EyeOff,
                              label: filesShowHidden ? 'Hide dotfiles' : 'Show dotfiles',
                              onPress: () => {
                                filesPageRef.current?.toggleHidden();
                                setFilesShowHidden((v) => !v);
                              },
                            },
                            {
                              icon: Upload,
                              label: 'Upload file',
                              onPress: () => filesPageRef.current?.uploadDocument(),
                            },
                            {
                              icon: Image,
                              label: 'Upload image',
                              onPress: () => filesPageRef.current?.uploadImage(),
                            },
                            {
                              icon: FolderPlus,
                              label: 'New folder',
                              onPress: () => filesPageRef.current?.createFolder(),
                            },
                            {
                              icon: RefreshCw,
                              label: 'Refresh',
                              onPress: () => filesPageRef.current?.refetch(),
                            },
                          ] as BottomBarMenuItem[]))
                    : undefined
                }
              />
            </View>
          )}
        </Drawer>
      </Drawer>

      <UserMenuSheet
        ref={userMenuSheetRef}
        sandboxLabel={sandboxLabel}
        sandboxHost={sandboxHost}
        onManageInstances={handleManageInstances}
        onAddInstance={handleAddInstance}
        onOpenSettings={handleGoToSettings}
        onOpenChangelog={handleOpenChangelog}
        onSignOut={handleSignOut}
        onSelectTheme={handleThemeSelect}
        activeTheme={themePreference}
        isSigningOut={isSigningOut}
      />

      <ViewChangesSheet
        ref={viewChangesSheetRef}
        sessionId={activeSessionId}
      />

      <ExportTranscriptSheet
        ref={exportTranscriptSheetRef}
        sessionId={activeSessionId}
      />

      {/* Command Palette */}
      <CommandPalette
        visible={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        sessions={sessions}
        onNewSession={handleNewSession}
        onSessionSelect={(id) => {
          if (id) {
            navigateToSession(id);
          } else {
            navigateToSession(null);
          }
        }}
        onPageSelect={(pageId) => {
          useTabStore.getState().navigateToPage(pageId);
        }}
        onSettings={handleGoToSettings}
        sandboxUrl={sandboxUrl}
        onFileSelect={(path) => {
          useTabStore.getState().navigateToPage('page:files');
          setPendingFilePath(path);
        }}
      />
    </>
  );
}
