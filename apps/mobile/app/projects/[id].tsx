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
  Modal,
  Platform,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { captureScreen } from 'react-native-view-shot';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Text } from '@/components/ui/text';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
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
import { SessionConnecting, type SessionConnectError } from '@/components/session/SessionConnecting';
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
import { LegacyChatsSection } from '@/components/menu/LegacyChatsSection';
import { haptics } from '@/lib/haptics';
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
import { AgentsPage } from '@/components/pages/AgentsPage';
import { SkillsPage } from '@/components/pages/SkillsPage';
import { MemoryPage } from '@/components/pages/MemoryPage';
import { LlmProvidersPage } from '@/components/pages/LlmProvidersPage';
import { TerminalPage } from '@/components/pages/TerminalPage';
import { SetupWizard } from '@/components/setup/SetupWizard';
import { InstanceOnboarding } from '@/components/setup/InstanceOnboarding';
import { ProvisioningProgress } from '@/components/provisioning/ProvisioningProgress';
import { useSandboxPoller } from '@/lib/platform/use-sandbox-poller';
import type { SandboxProviderName } from '@/lib/platform/client';
import { getSandboxUrl } from '@/lib/platform/client';
import { useProjectSessions, useCreateProjectSession, useProject } from '@/lib/projects/hooks';
import { ensureOpencodeSession, wakeProjectSession, getProjectSessionSandbox, restartProjectSession } from '@/lib/projects/projects-client';
import type { ProjectSession, ProjectSessionStatus, EnsureOpencodeResult } from '@/lib/projects/projects-client';
import { Avatar } from '@/components/ui/Avatar';
import {
  Eye, EyeOff, RefreshCw, Upload, Image, FolderPlus, LayoutGrid, List,
  FileText, Copy, Pencil, Trash2,
  Bot, Sparkles, Terminal, FolderOpen, Plug, Settings,
  ChevronsUpDown,
} from 'lucide-react-native';
import type { BottomBarMenuItem } from '@/components/session/BottomBar';
import { log } from '@/lib/logger';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { PageHeader } from '@/components/ui/page-header';
import BrandmarkBlack from '@/assets/brand/kortix-symbol-scale-effect-black.svg';
import BrandmarkWhite from '@/assets/brand/kortix-symbol-scale-effect-white.svg';
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

function ConnectingToWorkspace({
  isDark,
  phase,
}: {
  isDark: boolean;
  /** What we're actually waiting for — helps the user diagnose a stuck state. */
  phase: 'awaiting-sandbox' | 'provisioning' | 'checking-env';
}) {
  const router = useRouter();
  const [showEscape, setShowEscape] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Show recovery buttons after 10 seconds of waiting
  useEffect(() => {
    const timer = setTimeout(() => setShowEscape(true), 10_000);
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

  const handleBackToInstances = useCallback(() => {
    router.push('/(settings)/instances');
  }, [router]);

  // Diagnostic message — tells the user what we're actually waiting on so a
  // stuck state is less confusing. `awaiting-sandbox` is the one that hangs
  // silently with no polling activity; the others have logs ticking.
  const phaseText =
    phase === 'awaiting-sandbox'
      ? 'Waiting for sandbox to be assigned.'
      : phase === 'provisioning'
      ? 'Sandbox is still provisioning.'
      : 'Checking sandbox health and restoring your session.';

  // Restart only makes sense if we actually have a sandbox to talk to.
  const canRestart = phase === 'checking-env';

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
        {phaseText}
      </Text>

      {/* Recovery row — appears after 10s of waiting */}
      {showEscape && (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
          {canRestart && (
            <TouchableOpacity
              onPress={handleRestart}
              disabled={restarting}
              activeOpacity={0.7}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
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
          <TouchableOpacity
            onPress={handleBackToInstances}
            activeOpacity={0.7}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 999,
              backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
            }}
          >
            <Ionicons
              name="arrow-back-outline"
              size={14}
              color={isDark ? 'rgba(248,248,248,0.6)' : 'rgba(18,18,21,0.5)'}
            />
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: isDark ? 'rgba(248,248,248,0.6)' : 'rgba(18,18,21,0.5)' }}>
              Back to Instances
            </Text>
          </TouchableOpacity>
        </View>
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
      onPress={() => { haptics.tap(); onPress(item); }}
      onLongPress={() => {
        haptics.medium();
        Alert.alert(item.title || 'Session', undefined, [
          { text: 'Archive', onPress: () => onArchive?.(item.id) },
          { text: 'Delete', style: 'destructive', onPress: () => onDelete?.(item.id) },
          { text: 'Cancel', style: 'cancel' },
        ]);
      }}
      className={`rounded-2xl px-3 py-2.5 mb-1 ${isActive ? 'bg-muted' : ''}`}
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
              haptics.selection();
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
              onPress={() => { haptics.medium(); onArchive?.(item.id); }}
              className="p-1.5 mr-0.5"
              hitSlop={6}
              activeOpacity={0.6}
            >
              <Ionicons name="archive-outline" size={16} color={mutedColor} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => { haptics.medium(); onDelete?.(item.id); }}
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

// Quick-start suggestions for the project home composer. Mirrors the web's
// STARTER_PROMPTS (apps/web/src/lib/starter-prompts.ts); tapping a chip starts
// a session with that prompt. Lucide icons → nearest Ionicons equivalents.
const STARTER_PROMPTS: { id: string; icon: string; label: string; prompt: string }[] = [
  {
    id: 'company-memory',
    icon: 'business-outline',
    label: 'Onboard your agent',
    prompt:
      "Onboard me. Ask about my company — what we do, who our customers are, who's on the team, our products, our top priorities. Save what you learn into project memory so you remember it in every future session, and open a change request when you're done so I can review.",
  },
  {
    id: 'landing-page',
    icon: 'globe-outline',
    label: 'Build a landing page',
    prompt:
      'Build a sales-ready landing page for my product. Ask for the product name, the audience, and the key value props, then design and ship the page.',
  },
  {
    id: 'competitor-brief',
    icon: 'search-outline',
    label: 'Research competitors',
    prompt:
      'Research my top 3 competitors and write a one-page brief — positioning, pricing, what they do better, what they do worse, and where we can win.',
  },
  {
    id: 'pitch-deck',
    icon: 'easel-outline',
    label: 'Create a pitch deck',
    prompt:
      "Create a 5-slide pitch deck for a topic I'll tell you. Ask what it's about, who it's for, and what the one takeaway should be.",
  },
  {
    id: 'contract-draft',
    icon: 'document-text-outline',
    label: 'Draft a contract',
    prompt:
      'Draft a contract for me. Ask what kind (NDA, MSA, ToS, etc.), the parties involved, and any special terms, then produce a clean DOCX with proper citations.',
  },
  {
    id: 'data-analysis',
    icon: 'bar-chart-outline',
    label: 'Analyze a spreadsheet',
    prompt:
      "I'll share a spreadsheet — analyze it, find the patterns and outliers, and write me a short summary with the takeaways I should act on.",
  },
];

// ─── Project session list item (repo-first model) ──────────────────────────
// The project detail drawer lists the project's sessions (GET /projects/:id/
// sessions), each its own branch + sandbox. Unlike the OpenCode Session tree
// these are flat and carry a provisioning status, so we render name + status.

const PROJECT_SESSION_STATUS_META: Record<
  ProjectSessionStatus,
  { label: string; dot: string; pending: boolean }
> = {
  queued: { label: 'Queued', dot: '#F59E0B', pending: true },
  branching: { label: 'Branching', dot: '#F59E0B', pending: true },
  provisioning: { label: 'Provisioning', dot: '#F59E0B', pending: true },
  running: { label: 'Running', dot: '#22C55E', pending: false },
  stopped: { label: 'Stopped', dot: '#9CA3AF', pending: false },
  failed: { label: 'Failed', dot: '#EF4444', pending: false },
  completed: { label: 'Completed', dot: '#9CA3AF', pending: false },
};

function ProjectSessionListItem({
  item,
  isActive,
  onPress,
}: {
  item: ProjectSession;
  isActive: boolean;
  onPress: (s: ProjectSession) => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const mutedColor = isDark ? '#999999' : '#6e6e6e';
  const meta = PROJECT_SESSION_STATUS_META[item.status] ?? PROJECT_SESSION_STATUS_META.stopped;
  const title = item.name || item.branch_name || 'New session';

  return (
    <TouchableOpacity
      onPress={() => onPress(item)}
      className={`rounded-2xl px-3 py-2.5 mb-1 ${isActive ? 'bg-muted' : ''}`}
      activeOpacity={0.6}
    >
      <View className="flex-row items-center">
        <View className="h-2 w-2 rounded-full mr-2.5" style={{ backgroundColor: meta.dot }} />
        <Text
          className={`flex-1 text-sm ${isActive ? 'text-foreground font-semibold' : 'text-foreground'}`}
          numberOfLines={1}
        >
          {title}
        </Text>
        {meta.pending ? (
          <ActivityIndicator size="small" color={mutedColor} style={{ marginLeft: 8 }} />
        ) : item.status !== 'running' ? (
          <Text className="text-[11px] text-muted-foreground ml-2">{meta.label}</Text>
        ) : null}
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

/**
 * Probe a session sandbox's runtime health THROUGH the backend proxy — the same
 * `${sandboxUrl}/kortix/health` the web's useSandboxConnection polls. Beyond
 * reporting readiness, hitting the proxy keeps the sandbox routed/warm; the
 * backend's ensure-opencode probe alone doesn't, so without this a freshly-woken
 * sandbox can stay unreachable. Returns 'ready' once OpenCode reports up.
 */
type SandboxHealth = {
  status: 'ready' | 'starting' | 'unreachable';
  /**
   * Fatal runtime boot failure (e.g. repo materialization / git clone failed),
   * verbatim from /kortix/health `boot_error`. Null while healthy or still
   * booting — the sandbox only populates it on an actual failure, so it's a
   * safe "stop waiting" signal (see sandbox routes/health.ts).
   */
  bootError?: string | null;
};

async function probeSandboxHealth(sandboxUrl: string): Promise<SandboxHealth> {
  try {
    const token = await getAuthToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(`${sandboxUrl.replace(/\/$/, '')}/kortix/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 503) return { status: 'starting' }; // sandbox up, OpenCode still booting
    if (!res.ok) return { status: 'unreachable' };
    const data: any = await res.json().catch(() => null);
    const bootError =
      typeof data?.boot_error === 'string' && data.boot_error ? data.boot_error : null;
    if (data?.runtimeReady === true) return { status: 'ready' };
    if (data?.opencode === 'ok' || data?.opencode === true) return { status: 'ready' };
    if (data?.status && !['starting', 'down', 'error'].includes(data.status)) return { status: 'ready' };
    return { status: 'starting', bootError };
  } catch {
    return { status: 'unreachable' };
  }
}

/**
 * Deliver the composer's first prompt into a session's OpenCode root, once it
 * exists. Web parity: the project home stashes the prompt and sends it after the
 * session connects rather than passing `initial_prompt` to createProjectSession
 * (the boot-time KORTIX_INITIAL_PROMPT path can leave OpenCode perpetually
 * not-ready). Fire-and-forget — SessionPage's sync surfaces the message/reply.
 */
async function sendOpencodePrompt(
  sandboxUrl: string,
  opencodeSessionId: string,
  text: string,
): Promise<void> {
  try {
    const token = await getAuthToken();
    const res = await fetch(
      `${sandboxUrl.replace(/\/$/, '')}/session/${encodeURIComponent(opencodeSessionId)}/prompt_async`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      },
    );
    if (!res.ok) {
      log.error('[connect] initial prompt failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (err: any) {
    log.error('[connect] initial prompt error:', err?.message || err);
  }
}

// ─── Main screen ────────────────────────────────────────────────────────────

export default function ProjectSessionScreen() {
  // Cloned 1:1 from app/home.tsx — same three-pane layout (left drawer · session
  // middle · right drawer). projectId is the repo-first project we'll scope the
  // new API onto.
  const { id: projectId } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { colorScheme, setColorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const router = useRouter();
  const {
    sandboxUrl, sandboxId, isLoading: sandboxLoading, error: sandboxError,
    provisioningSandboxId, provisioningExternalId, provisioningProvider, onProvisioningComplete,
    switchSandbox,
  } = useSandboxContext();
  // Project view (web model): never gate on a global sandbox. Sandboxes are
  // resolved per session, so the screen renders immediately.
  const isProvisioning = false;

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
  const [setupState, setSetupState] = useState<'checking' | 'needed' | 'onboarding' | 'done'>('done');

  useEffect(() => {
    // Project view: the global-sandbox setup gate is disabled — the screen
    // renders immediately (web model). Sandboxes are resolved per session.
    return;
    // eslint-disable-next-line no-unreachable
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
  // The sandbox-update badge polls the GLOBAL sandbox (${sandboxUrl}/kortix/health)
  // — a legacy-shell concept that 403s on the repo-first project screen (sessions
  // get their own sandboxes). Disabled here; the badge still works on /home.
  const hasUpdate = false;

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
  const tabStateById = useTabStore((s) => s.tabStateById);
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
  // Repo-first project sessions (web model): GET /projects/:id/sessions.
  // This is what the left drawer lists for the project detail screen.
  const { data: projectSessions = [], isLoading: projectSessionsLoading } =
    useProjectSessions(projectId);
  const [activeProjectSessionId, setActiveProjectSessionId] = useState<string | null>(null);
  // A project session that's provisioning — the middle pane shows a connecting
  // state and the project-sessions poll opens it once its sandbox is ready.
  const [connectingProjectSessionId, setConnectingProjectSessionId] = useState<string | null>(null);
  // Inline runtime-failure state for the connecting screen (web parity: the
  // "OpenCode runtime is not ready" error). When set, the connecting branch
  // shows the error + a Restart button instead of spinning forever.
  const [connectError, setConnectError] = useState<SessionConnectError | null>(null);
  const [restartingSession, setRestartingSession] = useState(false);
  // Sessions whose connect loop ended in an error — guards the auto-connect
  // effect from immediately re-driving (and re-looping) a known-failed session.
  // Cleared on manual restart or when a different session is opened.
  const erroredSessionRef = useRef<string | null>(null);
  const createProjectSession = useCreateProjectSession(projectId);
  const { data: project } = useProject(projectId);
  const projectName = project?.name || 'Your project';
  const connectingStatusLabel = useMemo(() => {
    const ps = projectSessions.find((s) => s.session_id === connectingProjectSessionId);
    return `${(ps && PROJECT_SESSION_STATUS_META[ps.status]?.label) || 'Provisioning'}…`;
  }, [projectSessions, connectingProjectSessionId]);

  // Only touch a sandbox once a session is actually open (its sandbox is switched
  // in via connectToProjectSession). On the dashboard there is no authorized
  // sandbox — the global one is the stale repo-first default — so the legacy
  // OpenCode/Kortix proxy hooks must stay disabled to avoid 403s
  // ("Not authorized to access this sandbox").
  const sessionSandboxUrl = activeSessionId ? sandboxUrl : undefined;
  const { data: sessions = [], isLoading: sessionsLoading } =
    useSessions(sessionSandboxUrl);
  const { data: kortixProjects } = useKortixProjects(sessionSandboxUrl);
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

  // Tabs shown as pills in the BottomBar (session tabs + page tabs)
  const bottomBarTabs = useMemo(() => {
    const sessionPills = openTabIds.map((id) => {
      const s = sessions.find((sess) => sess.id === id);
      return {
        id,
        label: s?.title || 'Session',
        icon: 'chatbubble-outline' as const,
      };
    });
    const pagePills = openPageIds.map((id) => {
      const p = PAGE_TABS[id];
      // Dynamic project tabs (page:project:<id>): use projectName from tab state
      if (!p && id.startsWith('page:project:')) {
        const projectName = (tabStateById[id]?.projectName as string) || 'Project';
        return { id, label: projectName, icon: 'folder-outline' as const };
      }
      return {
        id,
        label: p?.label || id,
        icon: (p?.icon as any) || 'document-outline',
      };
    });
    return [...sessionPills, ...pagePills];
  }, [openTabIds, openPageIds, sessions, tabStateById]);

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
  const { data: agents = [] } = useOpenCodeAgents(sessionSandboxUrl);
  const { data: dashVisibleModels = [], allModels: dashAllModels = [], defaults: dashDefaults } = useOpenCodeModels(sessionSandboxUrl);
  const { data: dashConfig } = useOpenCodeConfig(sessionSandboxUrl);
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

  // Soft selection tick on drawer open/close so swipe-to-open and swipe-to-close
  // feel snappy. The Drawer component fires these callbacks once per transition,
  // so they don't repeat during the slide animation.
  const handleDrawerOpen = useCallback(() => { haptics.selection(); setDrawerOpen(true); }, []);
  const handleDrawerClose = useCallback(() => { haptics.selection(); setDrawerOpen(false); }, []);
  const handleRightDrawerOpen = useCallback(() => { haptics.selection(); setRightDrawerOpen(true); }, []);
  const handleRightDrawerClose = useCallback(() => { haptics.selection(); setRightDrawerOpen(false); }, []);

  const handleNewSession = useCallback(async () => {
    if (!projectId) return;
    try {
      haptics.tap();
      setDrawerOpen(false);
      // Repo-first new session (web parity): create a blank project session and
      // open it via the connecting state — the effect resolves the OpenCode pin
      // (ensure-opencode) once the sandbox is up. No global-sandbox POST /session.
      const session = await createProjectSession.mutateAsync({});
      setActiveProjectSessionId(session.session_id);
      navigateToSession(null);
      setConnectError(null);
      erroredSessionRef.current = null;
      setConnectingProjectSessionId(session.session_id);
    } catch (err: any) {
      log.error('❌ [Project] Failed to create session:', err?.message || err);
      Alert.alert('Error', err?.message || 'Failed to create session');
    }
  }, [projectId, createProjectSession, navigateToSession]);

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

  // Composer prompts awaiting their session's OpenCode root, keyed by session id.
  const pendingPromptsRef = useRef<Record<string, string>>({});

  // Switch the SandboxContext to a session's sandbox and render its chat. Needs
  // both the sandbox URL and the resolved OpenCode pin (opencode_session_id).
  const connectToProjectSession = useCallback((ps: ProjectSession) => {
    if (!ps.sandbox_url || !ps.opencode_session_id) return false;
    const externalId =
      ps.sandbox_url.match(/\/p\/([^/]+)\//)?.[1] || ps.sandbox_id || ps.session_id;
    switchSandbox({
      sandbox_id: ps.sandbox_id || ps.session_id,
      external_id: externalId,
      name: ps.name || 'Session',
      provider: (ps.sandbox_provider as SandboxProviderName) || 'daytona',
      base_url: ps.sandbox_url,
      status: 'running',
      created_at: ps.created_at,
      updated_at: ps.updated_at,
    });
    setConnectingProjectSessionId(null);
    setConnectError(null);
    erroredSessionRef.current = null;
    setActiveProjectSessionId(ps.session_id);
    navigateToSession(ps.opencode_session_id);
    // Deliver the composer's first prompt now that the OpenCode root exists.
    const pending = pendingPromptsRef.current[ps.session_id];
    if (pending) {
      delete pendingPromptsRef.current[ps.session_id];
      void sendOpencodePrompt(ps.sandbox_url, ps.opencode_session_id, pending);
    }
    return true;
  }, [switchSandbox, navigateToSession]);

  // Resolve the session's canonical OpenCode root (web parity: POST
  // ensure-opencode is the sole authority that writes opencode_session_id), then
  // open the chat. The sandbox/runtime can still be warming, so retry on
  // not_ready/unreachable with backoff — mirrors useCanonicalOpenCodeSession.
  const ensuringRef = useRef<string | null>(null);
  // End a connect loop in the inline failure state (web parity: InlineSessionError).
  // Keeps connectingProjectSessionId set so the connecting branch renders the
  // error, and records the session so the auto-connect effect won't re-drive it.
  const failConnect = useCallback((sessionId: string, err: SessionConnectError) => {
    erroredSessionRef.current = sessionId;
    setConnectError(err);
  }, []);
  // Bring a project session online and open it, mirroring the web's session boot
  // (app/projects/[id]/sessions/[sessionId]/page.tsx + useSandboxConnection):
  //   1. POLL GET /sessions/:id/sandbox — this GET DRIVES (re)provisioning on the
  //      backend (kickProvisionOnOpen) and returns the authoritative sandbox
  //      status. The web hammers it ~300ms; that polling is what advances the
  //      sandbox to 'active'. The list endpoint we poll elsewhere does NOT.
  //   2. once 'active': wake (idle auto-stop) + health-poll the proxy (warm/route),
  //   3. ensure-opencode resolves opencode_session_id once the runtime is up,
  //   4. switch + navigate + deliver the stashed prompt.
  // A cold boot can take minutes, so we poll patiently and fail only on a
  // definitive error/timeout.
  const ensureAndOpen = useCallback(async (sessionId: string) => {
    if (!projectId || ensuringRef.current === sessionId) return;
    ensuringRef.current = sessionId;
    const startedAt = Date.now();
    const MAX_WAIT_MS = 4 * 60_000;
    let lastWokeAt = 0;
    try {
      let attempt = 0;
      while (Date.now() - startedAt < MAX_WAIT_MS) {
        if (ensuringRef.current !== sessionId) return; // superseded by another open
        attempt += 1;

        // 1) Poll the sandbox endpoint — drives (re)provisioning on open + gives
        //    the authoritative status. null = 404 'not provisioned yet'.
        const sandbox = await getProjectSessionSandbox(projectId, sessionId);

        if (sandbox?.status === 'error') {
          failConnect(sessionId, {
            title: 'Session failed to start',
            message: 'The sandbox could not be provisioned.',
          });
          return;
        }

        if (sandbox?.status === 'active' && sandbox.external_id) {
          const sandboxUrl = getSandboxUrl(sandbox.external_id);

          // 2) Wake an idle-auto-stopped sandbox (row still reads active) +
          //    keep the proxy warm/routed (web: useSandboxConnection).
          if (Date.now() - lastWokeAt > 25_000) {
            lastWokeAt = Date.now();
            wakeProjectSession(projectId, sessionId).then(
              (w) => log.log('🌅 [connect] wake →', w?.status),
              () => {},
            );
          }
          const health = await probeSandboxHealth(sandboxUrl);

          // Fatal runtime boot failure (e.g. repo materialization / git clone
          // failed): stop waiting and surface it with a Restart button — web
          // parity with the "OpenCode runtime is not ready" screen. boot_error
          // is null during a normal boot, so this never false-positives.
          if (health.bootError) {
            failConnect(sessionId, {
              title: 'OpenCode runtime is not ready',
              message: 'The sandbox booted, but the project runtime did not become usable.',
              detail: health.bootError,
            });
            return;
          }

          // 3) Resolve the OpenCode pin.
          let updated: EnsureOpencodeResult | null = null;
          try {
            updated = await ensureOpencodeSession(projectId, sessionId);
          } catch (err: any) {
            log.log('🔄 [connect] ensure-opencode error:', err?.message || err);
          }
          log.log(
            `💓 [connect] attempt ${attempt}: sandbox=active health=${health.status} reason=${updated?.ensure?.reason ?? '-'} pin=${updated?.opencode_session_id ? 'ok' : '-'}`,
          );

          if (updated?.opencode_session_id) {
            connectToProjectSession({ ...updated, sandbox_url: sandboxUrl });
            return;
          }
          if (updated?.status === 'failed') {
            failConnect(sessionId, {
              title: 'Session failed to start',
              message: updated.error || 'The sandbox could not be provisioned.',
            });
            return;
          }
        } else {
          log.log(`💓 [connect] attempt ${attempt}: sandbox=${sandbox?.status ?? 'provisioning'}`);
        }

        await new Promise((r) => setTimeout(r, 1_500));
      }
      failConnect(sessionId, {
        title: 'Could not start session',
        message: 'The session runtime did not become ready in time. Please try again.',
      });
    } finally {
      if (ensuringRef.current === sessionId) ensuringRef.current = null;
    }
  }, [projectId, connectToProjectSession, failConnect]);

  // Open a project session from the drawer. Always enter the connecting state —
  // ensureAndOpen polls the sandbox endpoint (re-provisioning/waking as needed)
  // before opening, so even a previously-idle session comes back cleanly.
  const handleOpenProjectSession = useCallback((ps: ProjectSession) => {
    haptics.tap();
    setActiveProjectSessionId(ps.session_id);
    setDrawerOpen(false);
    navigateToSession(null);
    setConnectError(null);
    erroredSessionRef.current = null;
    setConnectingProjectSessionId(ps.session_id);
  }, [navigateToSession]);

  // Restart a session whose runtime failed to boot (web parity:
  // restartProjectSession). Tears down + re-provisions the sandbox, clears the
  // error/guard, and re-drives the connect loop.
  const handleRestartSession = useCallback(async () => {
    const sid = connectingProjectSessionId;
    if (!sid || restartingSession) return;
    haptics.tap();
    setRestartingSession(true);
    try {
      await restartProjectSession(projectId, sid);
      erroredSessionRef.current = null;
      ensuringRef.current = null;
      setConnectError(null);
      void ensureAndOpen(sid);
    } catch (err: any) {
      setConnectError({
        title: 'Restart failed',
        message: err?.message || 'Could not restart the session runtime. Please try again.',
      });
    } finally {
      setRestartingSession(false);
    }
  }, [connectingProjectSessionId, restartingSession, projectId, ensureAndOpen]);

  // Drive the connecting state: ensureAndOpen polls GET /sandbox (which provisions
  // on open), resolves the OpenCode pin, and opens the chat. It guards against
  // concurrent runs, so re-firing on re-render is harmless. A session that ended
  // in an error is skipped so we don't immediately re-loop it — recovery is the
  // explicit Restart button.
  useEffect(() => {
    if (!connectingProjectSessionId) return;
    if (erroredSessionRef.current === connectingProjectSessionId) return;
    void ensureAndOpen(connectingProjectSessionId);
  }, [connectingProjectSessionId, ensureAndOpen]);

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
      if (!projectId || isDashboardSending) return;
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
        // Create a BLANK project session (web parity). We deliberately do NOT
        // pass initial_prompt: that sets KORTIX_INITIAL_PROMPT, which makes the
        // sandbox run a boot-time agent step before marking OpenCode ready — and
        // that path can leave the runtime perpetually not-ready. Instead we stash
        // the prompt and deliver it once the session's OpenCode root exists (see
        // connectToProjectSession), exactly like the web home composer.
        const session = await createProjectSession.mutateAsync({});
        pendingPromptsRef.current[session.session_id] = finalText;
        setActiveProjectSessionId(session.session_id);
        // Enter the connecting state — the effect drives provisioning (GET
        // /sandbox), resolves the OpenCode pin, opens the chat, and delivers the
        // stashed prompt.
        navigateToSession(null);
        setConnectingProjectSessionId(session.session_id);
      } catch (err: any) {
        log.error('❌ [Project] Dashboard send failed:', err?.message || err);
        Alert.alert('Error', err?.message || 'Failed to start session');
      } finally {
        setIsDashboardSending(false);
      }
    },
    [projectId, isDashboardSending, createProjectSession, connectToProjectSession, navigateToSession],
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

  // Theme transition overlay — snapshot + crossfade to mirror web's view-transition blur effect
  const [themeTransitionUri, setThemeTransitionUri] = useState<string | null>(null);
  const themeTransitionOpacity = useRef(new Animated.Value(1)).current;

  const handleThemeSelect = useCallback(async (value: ThemePreference) => {
    if (value === themePreference) return;

    // Capture the current screen so we can crossfade from old theme to new
    let snapshotUri: string | null = null;
    try {
      snapshotUri = await captureScreen({
        format: 'jpg',
        quality: 0.8,
        result: 'tmpfile',
      });
    } catch {
      // Capture failed — fall through to instant switch
    }

    if (snapshotUri) {
      themeTransitionOpacity.setValue(1);
      setThemeTransitionUri(snapshotUri);
    }

    setThemePreference(value);
    try {
      await AsyncStorage.setItem(THEME_PREFERENCE_KEY, value);
    } catch {}
    setColorScheme(value === 'system' ? 'system' : value);

    if (snapshotUri) {
      // Let the new theme paint a frame before fading the snapshot out
      requestAnimationFrame(() => {
        Animated.timing(themeTransitionOpacity, {
          toValue: 0,
          duration: 400,
          useNativeDriver: true,
        }).start(() => {
          setThemeTransitionUri(null);
        });
      });
    }
  }, [themePreference, setColorScheme, themeTransitionOpacity]);

  const handleUserMenuOpen = useCallback(() => {
    userMenuSheetRef.current?.present();
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
        className="flex-1 bg-chrome-background"
        style={{ paddingTop: insets.top }}
      >
        {/* Kortix wordmark */}
        <View className="flex-row items-center justify-between px-5 pt-3 pb-4">
          <KortixLogo variant="logomark" size={18} color={isDark ? 'dark' : 'light'} />
        </View>

        {/* Top-level actions: New session / Search / Files */}
        <View className="px-2 mb-2">
          <TouchableOpacity
            onPress={() => { haptics.tap(); handleNewSession(); }}
            className="flex-row items-center rounded-lg px-3 py-2.5"
            activeOpacity={0.6}
          >
            <Ionicons name="create-outline" size={18} color={iconColor} />
            <Text className="flex-1 text-sm font-medium ml-3 text-foreground">New session</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { haptics.tap(); setDrawerOpen(false); setCommandPaletteOpen(true); }}
            className="flex-row items-center rounded-lg px-3 py-2.5"
            activeOpacity={0.6}
          >
            <Ionicons name="search-outline" size={18} color={iconColor} />
            <Text className="flex-1 text-sm font-medium ml-3 text-foreground">Search</Text>
          </TouchableOpacity>
        </View>

        {/* Projects header (collapsible) — above Sessions, matches web sidebar */}
        {sortedProjects.length > 0 && (
          <>
            <TouchableOpacity
              onPress={() => { haptics.selection(); setProjectsExpanded((v) => !v); }}
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
                    onPress={() => { haptics.tap(); handleProjectPress(project); }}
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
          onPress={() => { haptics.selection(); setSessionsExpanded((v) => !v); }}
          className="flex-row items-center justify-between px-5 py-2.5"
          activeOpacity={0.6}
        >
          <View className="flex-row items-center">
            <Ionicons name="list-outline" size={18} color={iconColor} />
            <Text className="text-sm font-medium ml-3 text-foreground">Sessions</Text>
          </View>
          <AnimatedChevron expanded={sessionsExpanded} color={mutedColor} size={16} />
        </TouchableOpacity>

        {/* Session list — the project's repo-first sessions */}
        {projectSessionsLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="small" color={mutedColor} />
          </View>
        ) : (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 20 }}
          >
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

        {/* Previous Chats — pre-OpenCode threads with bulk-convert (matches web sidebar) */}
        <LegacyChatsSection iconColor={iconColor} mutedColor={mutedColor} isDark={isDark} />

        {/* Bottom: user info — card style matching desktop */}
        <View
          className="px-3 pt-2"
          style={{ paddingBottom: insets.bottom + 8 }}
        >
          <TouchableOpacity
            onPress={() => { haptics.tap(); handleUserMenuOpen(); }}
            activeOpacity={0.8}
            className="flex-row items-center rounded-2xl border border-border"
            style={{
              height: 48,
              paddingHorizontal: 8,
              gap: 8,
              backgroundColor: isDark ? 'rgba(45, 45, 45, 0.4)' : 'rgba(229, 229, 229, 0.4)',
            }}
          >
            <View className="relative">
              <View className="h-8 w-8 rounded-full bg-muted items-center justify-center">
                <Text className="text-xs font-semibold text-muted-foreground uppercase">
                  {userDisplayName.charAt(0)}
                </Text>
              </View>
              {hasUpdate && (
                <View className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-red-500 border-2 border-background" />
              )}
            </View>
            <View className="flex-1" style={{ gap: 2 }}>
              <Text
                className="font-medium text-foreground"
                style={{ fontSize: 13, lineHeight: 16 }}
                numberOfLines={1}
              >
                {userDisplayName}
              </Text>
              <Text
                className="text-muted-foreground"
                style={{ fontSize: 11, lineHeight: 14 }}
                numberOfLines={1}
              >
                {userEmail || planLabel}
              </Text>
            </View>
            <ChevronsUpDown size={14} color={mutedColor} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }, [
    isDark,
    insets,
    projectSessions,
    projectSessionsLoading,
    activeProjectSessionId,
    handleOpenProjectSession,
    sessionsExpanded,
    projectsExpanded,
    sortedProjects,
    handleProjectPress,
    userDisplayName,
    userEmail,
    planLabel,
    hasUpdate,
    handleUserMenuOpen,
    handleNewSession,
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
    const phase: 'awaiting-sandbox' | 'provisioning' | 'checking-env' =
      !sandboxUrl && isProvisioning
        ? 'provisioning'
        : !sandboxUrl
        ? 'awaiting-sandbox'
        : 'checking-env';
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <ConnectingToWorkspace isDark={isDark} phase={phase} />
      </>
    );
  }

  // Show setup wizard if instance setup is not complete
  if (setupState === 'needed') {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <SetupWizard onComplete={handleSetupComplete} />
      </>
    );
  }

  // Show agent-driven onboarding after wizard completes
  if (setupState === 'onboarding') {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <InstanceOnboarding onComplete={handleOnboardingComplete} />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />

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
        swipeEnabled={!rightDrawerOpen}
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
          swipeEnabled={!drawerOpen}
          swipeEdgeWidth={80}
          swipeMinDistance={30}
          renderDrawerContent={renderRightDrawerContent}
        >
        {React.createElement(
          ViewShotComponent || View,
          ViewShotComponent
            ? { ref: viewShotRef, style: { flex: 1, backgroundColor: isDark ? '#09090B' : '#FFFFFF' } }
            : { className: 'flex-1 bg-background' },
          <>
          {/* Side hairlines — only needed for SessionPage / Dashboard, where the
              chat input pushes the page card up so its own borders don't reach
              the bottom of the screen. Other pages use PageContent which spans
              full height and renders its own side borders. */}
          {!activePageId && !showTabsOverview && (
            <>
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 0,
                  top: insets.top + 68,
                  bottom: 0,
                  width: 2,
                  backgroundColor: isDark ? '#222222' : '#e6e6e5',
                  zIndex: 10,
                }}
              />
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: insets.top + 68,
                  bottom: 0,
                  width: 2,
                  backgroundColor: isDark ? '#222222' : '#e6e6e5',
                  zIndex: 10,
                }}
              />
            </>
          )}
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
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
              onFileSelectionChange={(file) => setFilesSelectedName(file?.name ?? null)}
              onRequestMenu={() => bottomBarRef.current?.presentMenu()}
            />

          /* Active page tab — Memory */
          ) : activePageId === 'page:memory' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <MemoryPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — LLM Providers */
          ) : activePageId === 'page:llm-providers' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <LlmProvidersPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Secrets */
          ) : activePageId === 'page:secrets' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <SecretsPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Agents (web sidebar BUILD) */
          ) : activePageId === 'page:agents' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <AgentsPage
              page={PAGE_TABS[activePageId]}
              projectId={projectId}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Skills (web sidebar BUILD) */
          ) : activePageId === 'page:skills' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <SkillsPage
              page={PAGE_TABS[activePageId]}
              projectId={projectId}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Terminal */
          ) : activePageId === 'page:terminal' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <TerminalPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Updates */
          ) : activePageId === 'page:updates' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <UpdatesPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — SSH */
          ) : activePageId === 'page:ssh' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <SSHPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Running Services */
          ) : activePageId === 'page:running-services' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <RunningServicesPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Browser */
          ) : activePageId === 'page:browser' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <BrowserPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Agent Browser */
          ) : activePageId === 'page:agent-browser' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <AgentBrowserPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Integrations */
          ) : activePageId === 'page:integrations' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <IntegrationsTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Triggers / Scheduled Tasks */
          ) : activePageId === 'page:triggers' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <ScheduledTasksTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — API Keys */
          ) : activePageId === 'page:api' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <ApiKeysTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Channels */
          ) : activePageId === 'page:channels' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <ChannelsTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Tunnel */
          ) : activePageId === 'page:tunnel' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <TunnelTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Workspace */
          ) : activePageId === 'page:workspace' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <WorkspacePage
              ref={workspacePageRef}
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
              onCreateSessionWithPrompt={handleCreateSessionWithPrompt}
            />

          /* Active page tab — Projects list */
          ) : activePageId === 'page:projects' && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <ProjectsPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — Single project detail (dynamic: page:project:{id}) */
          ) : activePageId?.startsWith('page:project:') && !showTabsOverview ? (
            <ProjectDetailPage
              projectId={activePageId.replace('page:project:', '')}
              onBack={() => {
                // Go back to projects list
                useTabStore.getState().navigateToPage('page:projects');
              }}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active page tab — other pages (placeholder) */
          ) : activePageId && PAGE_TABS[activePageId] && !showTabsOverview ? (
            <PlaceholderPage
              page={PAGE_TABS[activePageId]}
              onBack={handleBack}
              onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
              onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
              isDrawerOpen={drawerOpen}
              isRightDrawerOpen={rightDrawerOpen}
            />

          /* Active session */
          ) : activeSessionId && !showTabsOverview ? (
            <SessionPage sessionId={activeSessionId} onBack={handleBack} onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen} onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen} isDrawerOpen={drawerOpen} isRightDrawerOpen={rightDrawerOpen} />

          /* Connecting — a project session is provisioning */
          ) : connectingProjectSessionId && !showTabsOverview ? (
            <View style={{ flex: 1 }} className="bg-background">
              <PageHeader
                title={projectName}
                onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
                isDrawerOpen={drawerOpen}
                onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
                isRightDrawerOpen={rightDrawerOpen}
              />
              <View
                style={{
                  flex: 1,
                  marginTop: -24,
                  borderTopLeftRadius: 28,
                  borderTopRightRadius: 28,
                  overflow: 'hidden',
                  borderTopWidth: 2,
                  borderLeftWidth: 2,
                  borderRightWidth: 2,
                  borderColor: isDark ? '#222222' : '#e6e6e5',
                }}
                className="bg-background"
              >
                <SessionConnecting
                  statusLabel={connectingStatusLabel}
                  error={connectError}
                  onRestart={handleRestartSession}
                  restarting={restartingSession}
                />
              </View>
            </View>

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
              <PageHeader
                title={projectName}
                onOpenDrawer={drawerOpen ? handleDrawerClose : handleDrawerOpen}
                isDrawerOpen={drawerOpen}
                onOpenRightDrawer={rightDrawerOpen ? handleRightDrawerClose : handleRightDrawerOpen}
                isRightDrawerOpen={rightDrawerOpen}
              />

              {/* Rounded card tucks under the header (curved edge), matching SessionPage */}
              <Animated.View
                style={{
                  flex: 1,
                  marginTop: -24,
                  borderTopLeftRadius: 28,
                  borderTopRightRadius: 28,
                  overflow: 'hidden',
                  borderTopWidth: 2,
                  borderLeftWidth: 2,
                  borderRightWidth: 2,
                  borderColor: isDark ? '#222222' : '#e6e6e5',
                  opacity: isDashboardSending ? 0.3 : 1,
                }}
                className="items-center justify-center px-8 bg-background"
              >
                {/* Kortix brandmark wallpaper — faded symbol behind the hero,
                    clipped by the card (web parity: ProjectHome brandmark). */}
                <View
                  pointerEvents="none"
                  style={[
                    StyleSheet.absoluteFill,
                    { alignItems: 'center', justifyContent: 'center', opacity: isDark ? 0.55 : 0.65 },
                  ]}
                >
                  {(() => {
                    const Brandmark = isDark ? BrandmarkWhite : BrandmarkBlack;
                    const brandW = windowWidth * 1.15;
                    return <Brandmark width={brandW} height={brandW * (462 / 393)} />;
                  })()}
                </View>

                <Avatar variant="custom" size={64} fallbackText={projectName} />
                <Text
                  className="mt-4 text-2xl font-bold text-foreground text-center"
                  numberOfLines={2}
                >
                  {projectName}
                </Text>
                <Text
                  className="mt-2 text-sm text-center text-muted-foreground"
                  style={{ maxWidth: 320 }}
                >
                  Describe a task and your agent gets to work.
                </Text>
              </Animated.View>

              {/* Quick-start suggestion chips (web parity) — tap to start a session */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                style={{ flexGrow: 0 }}
                contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 10, gap: 8 }}
              >
                {STARTER_PROMPTS.map((p) => (
                  <TouchableOpacity
                    key={p.id}
                    onPress={() => { haptics.tap(); handleDashboardSend(p.prompt, {}); }}
                    disabled={isDashboardSending}
                    activeOpacity={0.7}
                    className="flex-row items-center rounded-full border border-border bg-card px-3 py-1.5"
                  >
                    <Ionicons
                      name={p.icon as any}
                      size={13}
                      color={isDark ? '#999999' : '#6e6e6e'}
                      style={{ marginRight: 6 }}
                    />
                    <Text className="text-xs text-muted-foreground">{p.label}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <View>
                <SessionChatInput
                  onSend={handleDashboardSend}
                  placeholder="Describe a task to start a session…"
                  disabled={isDashboardSending}
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
                  sandboxUrl={sessionSandboxUrl}
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
                tabs={bottomBarTabs}
                activeTabId={activePageId || activeSessionId}
                onSelectTab={(tabId) => {
                  if (tabId.startsWith('page:')) {
                    useTabStore.getState().navigateToPage(tabId);
                  } else {
                    useTabStore.getState().navigateToSession(tabId);
                  }
                }}
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
        sandboxUrl={sessionSandboxUrl}
        onFileSelect={(path) => {
          useTabStore.getState().navigateToPage('page:files');
          setPendingFilePath(path);
        }}
      />

      {/* Theme transition overlay — crossfade snapshot of previous theme */}
      {themeTransitionUri && (
        <Modal
          visible
          transparent
          statusBarTranslucent
          animationType="none"
          hardwareAccelerated
        >
          <Animated.Image
            source={{ uri: themeTransitionUri }}
            resizeMode="cover"
            fadeDuration={0}
            style={[StyleSheet.absoluteFillObject, { opacity: themeTransitionOpacity }]}
            pointerEvents="none"
          />
        </Modal>
      )}
    </>
  );
}
