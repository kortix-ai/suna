/**
 * ProjectScreen — single-column project screen.
 *
 * Presents the project screen as one column that switches between three states:
 *   - project home (ProjectHome — Kortix symbol, fixed greeting, composer)
 *   - a thread (the existing SessionPage — reused verbatim)
 *   - a tool page (Files / Terminal / Browser / … — the existing page components)
 *
 * It REUSES the legacy screen's connect/streaming/tab-store/sandbox engine 1:1:
 * every hook, ref, effect and handler that drives session creation, the /start
 * connect loop, and OpenCode pinning is copied verbatim from
 * ProjectScreenLegacy (roughly lines 904–1780). Only the presentation (the old
 * three-pane drawer JSX) is replaced.
 *
 * It is the layout of app/projects/[id]/: a nested stack of project home
 * (index), at most one covering route: the open page, thread, or connecting
 * session (view), Sessions, Files, or Account, and the sub-pages pushed over
 * it (page: project Settings, Schedules, Secrets). Every project page shows
 * the hamburger and the drawer opens on it, except a sub-page, which shows
 * Go back. Android back from a sub-page pops it; from a covering route it
 * returns to project home; from project home it does nothing. Only the
 * switcher sheet (COR-124/COR-157 Task 4) leaves this project, for a
 * different one (see ProjectRoutes).
 */

import React, { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { newConfigPrompt } from '@kortix/shared';
import { View, BackHandler, Platform } from 'react-native';
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';

import { getAuthToken } from '@/api/config';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useSessions, useCreateSession } from '@/lib/platform/hooks';
import { SessionPage } from '@/components/session/SessionPage';
import { SessionConnecting, type SessionConnectError } from '@/components/session/SessionConnecting';
import { SessionThreadTitle } from '@/components/session/SessionThreadTitle';
import { appIsActive, useWarmProjectSession } from '@/hooks/useWarmProjectSession';
import { warmSessionPool } from '@/lib/session/warm-session-pool';
import {
  CommonActions,
  StackActions,
  useFocusEffect,
  useNavigation,
  type NavigationProp,
  type ParamListBase,
} from 'expo-router/react-navigation';
import { useAuthContext } from '@/contexts';
import { useTabStore, PAGE_TABS } from '@/stores/tab-store';
import { useLastProjectStore } from '@/stores/last-project-store';
import {
  PROJECT_ACCOUNT_ROUTE,
  PROJECT_FILES_ROUTE,
  PROJECT_HOME_ROUTE,
  PROJECT_PAGE_ROUTE,
  PROJECT_SESSIONS_ROUTE,
  PROJECT_VIEW_ROUTE,
  ProjectRouteProvider,
  backFromSubPage,
  type ProjectRouteValue,
} from '@/components/session/ProjectRoutes';
import { FloatingMenuButton } from '@/components/session/FloatingMenuButton';
import {
  androidBackMove,
  pageBackMove,
  returnThreadForPage,
  drawerRouteMove,
  drawerSessionRowMove,
  returnHomeMove,
  shownProjectSessionId,
  projectEdgeGesture,
  homeAndRoute,
  subPageOpenMove,
  type ProjectDrawerRoute,
  type SubPageId,
} from '@/lib/session/project-stack';
import { ProjectSwitcherSheet } from '@/components/projects/ProjectSwitcherSheet';
import {
  leaveSandboxOnFocus,
  pendingOpenedThread,
  showsSessionContent as showsSessionContentFor,
  threadSandboxReady,
  type OpenedThread,
} from '@/lib/session/session-sandbox';
import { TabsOverview } from '@/components/session/TabsOverview';
import { ProjectHome, type ProjectHomeSubmit } from '@/components/session/ProjectHome';
import { uploadAttachments, withAttachments, type AttachedFile } from '@/lib/session/attachments';
import { resolveSessionTitle, sessionDisplayTitle } from '@/lib/session/session-list';
import { subAgentRelation, subAgentsOf } from '@/lib/session/sub-agents';
import { ProjectLeftDrawer } from '@/components/session/ProjectLeftDrawer';
import {
  PageContextMenuSheet,
  type PageContextMenuTarget,
} from '@/components/session/PageContextMenuSheet';
import {
  SessionActionsSheet,
  type SessionActionsSheetRef,
} from '@/components/session/SessionActionsSheet';
import { Drawer } from 'react-native-drawer-layout';
import type { SheetRef } from '@/components/kortix/sheet';
import { haptics } from '@/lib/haptics';
import { log } from '@/lib/logger';
import { useQueryClient } from '@tanstack/react-query';
import {
  projectKeys,
  useAccounts,
  useProject,
  useProjectSessions,
  useCreateProjectSession,
} from '@/lib/projects/hooks';
import { useReviewItems } from '@/lib/review/use-review';
import { countReviewItemsBySegment } from '@kortix/sdk';
import {
  deleteProjectSession,
  startProjectSession,
  restartProjectSession,
} from '@/lib/projects/projects-client';
import type {
  ProjectSession,
  SessionStartResult,
} from '@/lib/projects/projects-client';
import { connectStepFromRequestError, connectStepFromStart } from '@/lib/session/connect-step';
import { useToast } from '@/components/kortix/toast-provider';
import { getUpgradeGate } from '@/lib/billing/upgrade-gate';
import { useUpgradeSheetStore } from '@/stores/upgrade-sheet-store';
import { getSandboxUrl } from '@/lib/platform/client';
import type { SandboxProviderName } from '@/lib/platform/client';
import { useTabScreenshotStore } from '@/stores/tab-screenshot-store';

// ── Tool pages (reused verbatim from the legacy page ternary) ──
import type { FilesPageRef } from '@/components/pages/FilesPage';
import type { WorkspacePageRef } from '@/components/pages/WorkspacePage';

// A tool page renders only while it is the open page, so its module is required
// on first render, not when the app starts. Metro's `require` is synchronous:
// no Suspense boundary and no fallback flash. Modules are cached after the
// first call, so each later access is a lookup.
const Pages = {
  get PlaceholderPage(): typeof import('@/components/session/PlaceholderPage').PlaceholderPage {
    return require('@/components/session/PlaceholderPage').PlaceholderPage;
  },
  get UpdatesPage(): typeof import('@/components/pages/UpdatesPage').UpdatesPage {
    return require('@/components/pages/UpdatesPage').UpdatesPage;
  },
  get SSHPage(): typeof import('@/components/pages/SSHPage').SSHPage {
    return require('@/components/pages/SSHPage').SSHPage;
  },
  get RunningServicesPage(): typeof import('@/components/pages/RunningServicesPage').RunningServicesPage {
    return require('@/components/pages/RunningServicesPage').RunningServicesPage;
  },
  get BrowserPage(): typeof import('@/components/pages/BrowserPage').BrowserPage {
    return require('@/components/pages/BrowserPage').BrowserPage;
  },
  get FilesPage(): typeof import('@/components/pages/FilesPage').FilesPage {
    return require('@/components/pages/FilesPage').FilesPage;
  },
  get ConnectionsTabPage(): typeof import('@/components/pages/ConnectionsTabPage').ConnectionsTabPage {
    return require('@/components/pages/ConnectionsTabPage').ConnectionsTabPage;
  },
  get ScheduledTasksTabPage(): typeof import('@/components/pages/ScheduledTasksPage').ScheduledTasksTabPage {
    return require('@/components/pages/ScheduledTasksPage').ScheduledTasksTabPage;
  },
  get ApiKeysTabPage(): typeof import('@/components/pages/ApiKeysPage').ApiKeysTabPage {
    return require('@/components/pages/ApiKeysPage').ApiKeysTabPage;
  },
  get TunnelTabPage(): typeof import('@/components/pages/TunnelPage').TunnelTabPage {
    return require('@/components/pages/TunnelPage').TunnelTabPage;
  },
  get WorkspacePage(): typeof import('@/components/pages/WorkspacePage').WorkspacePage {
    return require('@/components/pages/WorkspacePage').WorkspacePage;
  },
  get AgentBrowserPage(): typeof import('@/components/pages/AgentBrowserPage').AgentBrowserPage {
    return require('@/components/pages/AgentBrowserPage').AgentBrowserPage;
  },
  get SecretsPage(): typeof import('@/components/pages/SecretsPage').SecretsPage {
    return require('@/components/pages/SecretsPage').SecretsPage;
  },
  get ConnectorsPage(): typeof import('@/components/pages/ConnectorsPage').ConnectorsPage {
    return require('@/components/pages/ConnectorsPage').ConnectorsPage;
  },
  get SecretsNavPage(): typeof import('@/components/pages/SecretsNavPage').SecretsNavPage {
    return require('@/components/pages/SecretsNavPage').SecretsNavPage;
  },
  get SchedulesPage(): typeof import('@/components/pages/SchedulesPage').SchedulesPage {
    return require('@/components/pages/SchedulesPage').SchedulesPage;
  },
  get ChangesPage(): typeof import('@/components/pages/ChangesPage').ChangesPage {
    return require('@/components/pages/ChangesPage').ChangesPage;
  },
  get ReviewPage(): typeof import('@/components/pages/ReviewPage').ReviewPage {
    return require('@/components/pages/ReviewPage').ReviewPage;
  },
  get FilesNavPage(): typeof import('@/components/pages/FilesNavPage').FilesNavPage {
    return require('@/components/pages/FilesNavPage').FilesNavPage;
  },
  get DevPage(): typeof import('@/components/pages/DevPage').DevPage {
    return require('@/components/pages/DevPage').DevPage;
  },
  get SettingsNavPage(): typeof import('@/components/pages/SettingsNavPage').SettingsNavPage {
    return require('@/components/pages/SettingsNavPage').SettingsNavPage;
  },
  get MemoryPage(): typeof import('@/components/pages/MemoryPage').MemoryPage {
    return require('@/components/pages/MemoryPage').MemoryPage;
  },
  get ProjectsPage(): typeof import('@/components/pages/ProjectsPage').ProjectsPage {
    return require('@/components/pages/ProjectsPage').ProjectsPage;
  },
  get ProjectDetailPage(): typeof import('@/components/pages/ProjectDetailPage').ProjectDetailPage {
    return require('@/components/pages/ProjectDetailPage').ProjectDetailPage;
  },
};

// ─── Module-local helpers (copied verbatim from ProjectScreenLegacy) ─────────

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
    if (data?.status && !['starting', 'down', 'error'].includes(data.status))
      return { status: 'ready' };
    return { status: 'starting', bootError };
  } catch {
    return { status: 'unreachable' };
  }
}

/**
 * Deliver the composer's first prompt into a session's OpenCode root, once it
 * exists. Web parity: the project home stashes the prompt and sends it after the
 * session connects rather than passing `initial_prompt` to createProjectSession
 * (the boot-time first-turn path can leave OpenCode perpetually
 * not-ready). Fire-and-forget — SessionPage's sync surfaces the message/reply.
 */
async function sendOpencodePrompt(
  sandboxUrl: string,
  opencodeSessionId: string,
  text: string,
  picks?: ProjectHomeSubmit['picks'],
  agent?: string | null
): Promise<boolean> {
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
        // The same body the thread sends (SessionPage): model and level at the top.
        body: JSON.stringify({
          parts: [{ type: 'text', text }],
          ...(picks ? { model: picks.model, variant: picks.variant } : {}),
          ...(agent ? { agent } : {}),
        }),
      }
    );
    if (!res.ok) {
      // The response body is read for development logs only.
      if (__DEV__) {
        log.error('[connect] initial prompt failed:', res.status, await res.text().catch(() => ''));
      } else {
        log.error('[connect] initial prompt failed:', res.status);
      }
      return false;
    }
    return true;
  } catch (err: any) {
    log.error('[connect] initial prompt error:', err?.message || err);
    return false;
  }
}

/** A project-home prompt waiting for its session's sandbox. */
interface PendingPrompt {
  text: string;
  files: AttachedFile[];
  /** The model and thinking level picked on project home (`firstPromptPicks`). */
  picks: ProjectHomeSubmit['picks'];
  /** The agent picked on project home. */
  agent: string | null;
}

/**
 * Upload a pending prompt's files into the now-running sandbox, then send the
 * prompt with their `<file>` references. An upload failure still sends the
 * text, like the thread composer.
 */
async function deliverPendingPrompt(
  sandboxUrl: string,
  opencodeSessionId: string,
  { text, files, picks, agent }: PendingPrompt
): Promise<boolean> {
  let fileBlock = '';
  try {
    fileBlock = await uploadAttachments(sandboxUrl, files);
  } catch (err: any) {
    log.error('[connect] attachment upload failed:', err?.message || err);
  }
  return sendOpencodePrompt(sandboxUrl, opencodeSessionId, withAttachments(text, fileBlock), picks, agent);
}

// ─── Main screen ────────────────────────────────────────────────────────────

/**
 * The drawer's close spring (Jay, 2026-09-22). The library's one spring
 * (stiffness 1000, damping 500, mass 3) is 4.6× overdamped: its slow pole
 * decays at ~2/s, so a close crawls over its last third. This one is
 * critically damped (damping = 2·√stiffness at mass 1): 90% of the travel in
 * ~195ms, settled in ~330ms, no overshoot. It stays a spring, so a swipe
 * release keeps its velocity. Open keeps the library spring: an exit runs
 * faster than an enter.
 *
 * `closeSpringConfig` is not a library prop: it comes from
 * `patches/react-native-drawer-layout+4.2.10.patch`. When the patch is not
 * applied (`npx patch-package` after an install), `tsc` fails on the prop.
 * Module scope: the library lists it as a `useCallback` dependency.
 */
const DRAWER_CLOSE_SPRING = { stiffness: 400, damping: 40, mass: 1 };
/** Shared empty list: a fresh `[]` per render would re-render the thread. */
const EMPTY_SUB_AGENTS: ProjectSession[] = [];

export function ProjectScreen() {
  const { id: projectId } = useLocalSearchParams<{ id: string }>();

  // Tabs are remembered PER PROJECT: switch the tab store onto this project's
  // scope before the first paint (see ProjectScreenLegacy).
  // `scopeReady` stays false for the first render, while the store can still
  // hold another screen's state: the project routes treat that render as
  // project home, so opening a project never flashes a page push.
  const [scopeReady, setScopeReady] = useState(false);
  useLayoutEffect(() => {
    if (!projectId) return;
    useTabStore.getState().setScope(projectId);
    setScopeReady(true);
  }, [projectId]);

  // The app reopens this project next launch (app/index.tsx → lib/projects/landing).
  const { user } = useAuthContext();
  const userId = user?.id;
  useEffect(() => {
    if (userId && projectId) useLastProjectStore.getState().remember(userId, projectId);
  }, [userId, projectId]);

  const { sandboxUrl, switchSandbox, clearSandbox } = useSandboxContext();
  // Polls pause while a root screen (Account, settings) covers the project.
  const isFocused = useIsFocused();

  // The per-page context menu (Workspace / Files "···").
  const pageMenuRef = useRef<SheetRef>(null);
  const [pageMenuTarget, setPageMenuTarget] = useState<PageContextMenuTarget | null>(null);
  // Page refs (some tool pages drive imperative actions).
  const filesPageRef = useRef<FilesPageRef>(null);
  const workspacePageRef = useRef<WorkspacePageRef>(null);
  // The session actions sheet (COR-140 Task 5): one instance for the thread's
  // "···", the Sessions page's long press, and the drawer's session row long
  // press. `openSessionActions` goes on ProjectRouteValue, so every consumer
  // reaches it without its own state.
  const actionsSheetRef = useRef<SessionActionsSheetRef>(null);
  // `initialView` (COR-140): the thread header's title tap opens this same
  // sheet straight to Rename, instead of a second rename implementation.
  const openSessionActions = useCallback((session: ProjectSession, initialView?: 'rename') => {
    actionsSheetRef.current?.present(session, initialView);
  }, []);
  // The project/account switcher (COR-124): mounted here once, beside the
  // other project sheets, not inside the drawer's content. The drawer's
  // switcher row opens it (`onOpenSwitcher`); the drawer stays open behind
  // the sheet, and a picked project closes both.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const openSwitcher = useCallback(() => setSwitcherOpen(true), []);
  const closeSwitcher = useCallback(() => setSwitcherOpen(false), []);
  // The switcher opens on the project's own account (a deep link can open a
  // project in an account other than the selected one). Same queries as
  // the drawer's switcher row, so react-query shares them.
  const { data: project } = useProject(projectId);
  const accountsQuery = useAccounts();
  const queryClient = useQueryClient();

  // Warm sessions (web parity): one booted session held while this project is
  // open and the app is in the foreground, so a home send skips the sandbox
  // boot. Gated by the project's `warm_sessions` flag (billed compute).
  useWarmProjectSession(projectId, project?.experimental?.warm_sessions === true);
  // Opening a session any other way uses it: a held warm session with that id
  // is no longer a candidate, so drop it and keep one ready.
  const releaseWarmSession = useCallback((sessionId: string) => {
    const dropped = warmSessionPool.dropBySessionId(sessionId);
    if (dropped && appIsActive()) void warmSessionPool.ensure(dropped, { excludeSessionId: sessionId });
  }, []);

  // Persisted tab state (survives app restarts)
  const activeSessionId = useTabStore((s) => s.activeSessionId);
  const activePageId = useTabStore((s) => s.activePageId);
  const showTabsOverview = useTabStore((s) => s.showTabsOverview);
  const openTabIds = useTabStore((s) => s.openTabIds);
  const navigateToSession = useTabStore((s) => s.navigateToSession);
  const closeTab = useTabStore((s) => s.closeTab);
  const closeAllTabs = useTabStore((s) => s.closeAllTabs);
  const setShowTabsOverview = useTabStore((s) => s.setShowTabsOverview);

  // Data
  // Repo-first project sessions (web model): GET /projects/:id/sessions.
  const { data: projectSessions = [] } = useProjectSessions(projectId, { poll: isFocused });
  // A project session that's provisioning — the middle pane shows a connecting
  // state and the project-sessions poll opens it once its sandbox is ready.
  const [connectingProjectSessionId, setConnectingProjectSessionId] = useState<string | null>(null);
  // Inline runtime-failure state for the connecting screen (web parity).
  const [connectError, setConnectError] = useState<SessionConnectError | null>(null);
  const [restartingSession, setRestartingSession] = useState(false);
  const toast = useToast();
  // Sessions whose connect loop ended in an error — guards the auto-connect
  // effect from immediately re-driving (and re-looping) a known-failed session.
  const erroredSessionRef = useRef<string | null>(null);
  // The session id THIS screen just created (New session / a project-home
  // send) — not one reopened from the sessions list. Cancel deletes a fresh
  // session server-side; a reopened session may hold real history the user
  // still wants, so Cancel there only leaves the connect loop client-side
  // (see handleCancelConnect).
  const freshSessionIdRef = useRef<string | null>(null);
  // True while the store is on project home. Assigned on every render (below,
  // once `isHome` is computed) and set at once by `goHome`, so a callback that
  // fires between a state update and its render still reads the new value.
  const isHomeRef = useRef(true);
  // The typed text of a fresh dashboard send, keyed by the session id it
  // created — shown as the loading page's first message (and its title until
  // the session has one) and, read-and-cleared once, restored into the
  // composer if the user leaves a failed start ("Back to project",
  // `ProjectHome`'s `takeInitialDraft`). Cleared once the session connects.
  const firstMessageRef = useRef<Record<string, string>>({});
  const pendingDraftRef = useRef('');
  const takeInitialDraft = useCallback(() => {
    const draft = pendingDraftRef.current;
    pendingDraftRef.current = '';
    return draft;
  }, []);
  const createProjectSession = useCreateProjectSession(projectId);
  const openUpgradeSheet = useUpgradeSheetStore((state) => state.openUpgradeSheet);

  // Only touch a sandbox once a session is actually open (its sandbox is switched
  // in via connectToProjectSession). On the project home there is no authorized
  // sandbox — keep the OpenCode/Kortix proxy hooks disabled to avoid 403s.
  const sessionSandboxUrl = activeSessionId ? sandboxUrl : undefined;
  const { data: sessions = [] } = useSessions(sessionSandboxUrl);
  const createSession = useCreateSession(sandboxUrl);
  // Review items that wait for the user. The project sheet that used to show
  // this as its Review row's badge is deleted (COR-123/COR-160 Task 3); the
  // drawer's Review row carries the same count now (Task 4). Open change
  // requests are among them (the API adapts them into the list).
  const reviewItems = useReviewItems(projectId ?? null, { poll: isFocused });
  const reviewNeedsYouCount = useMemo(
    () => countReviewItemsBySegment(reviewItems.data ?? []).needs_you,
    [reviewItems.data]
  );

  // Split sessions into active (TabsOverview grid).
  const activeSessions = useMemo(
    () => sessions.filter((s) => !(s.time as any).archived),
    [sessions]
  );

  const showUpgradeForError = useCallback(
    (error: unknown) => {
      const gate = getUpgradeGate(error);
      if (!gate) return false;
      openUpgradeSheet(gate);
      return true;
    },
    [openUpgradeSheet]
  );

  // ── Handlers (copied verbatim from ProjectScreenLegacy) ──

  const handleNewSession = useCallback(async () => {
    if (!projectId) return;
    try {
      haptics.tap();
      // Repo-first new session (web parity): create a blank project session and
      // open it via the connecting state — the effect resolves the OpenCode pin
      // (ensure-opencode) once the sandbox is up. No global-sandbox POST /session.
      const session = await createProjectSession.mutateAsync({});
      navigateToSession(null);
      setConnectError(null);
      erroredSessionRef.current = null;
      freshSessionIdRef.current = session.session_id;
      setConnectingProjectSessionId(session.session_id);
    } catch (err: any) {
      if (showUpgradeForError(err)) return;
      log.error('❌ [Project] Failed to create session:', err?.message || err);
      toast.error(err?.message || 'Failed to create session');
    }
  }, [projectId, createProjectSession, navigateToSession, showUpgradeForError, toast]);

  const handleCreateSessionWithPrompt = useCallback(
    async (title: string, prompt: string) => {
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
    },
    [sandboxUrl, createSession, navigateToSession]
  );

  // Composer prompts awaiting their session's OpenCode root, keyed by session id.
  const pendingPromptsRef = useRef<Record<string, PendingPrompt>>({});
  // The thread the connect flow opened and the exact sandbox URL it switched
  // in. A ref: the thread (zustand) can commit before the sandbox (React
  // state), and that render must already see the expected URL.
  const openedThreadRef = useRef<OpenedThread | null>(null);
  // The thread a tool page was opened over (its OpenCode session id), for the
  // way back. Every opener is covered: the project sheet's rows, and a thread's
  // own links (Connect provider). Read by `returnToThread`, cleared by `goHome`.
  const returnThreadRef = useRef<string | null>(null);
  useEffect(
    () =>
      useTabStore.subscribe((state, previous) => {
        if (!state.activePageId || state.activePageId === previous.activePageId) return;
        returnThreadRef.current = returnThreadForPage({
          activeSessionId: previous.activeSessionId,
          activePageId: previous.activePageId,
          current: returnThreadRef.current,
        });
      }),
    []
  );

  // Switch the SandboxContext to a session's sandbox and render its chat. Needs
  // both the sandbox URL and the resolved OpenCode pin (opencode_session_id).
  const connectToProjectSession = useCallback(
    (ps: ProjectSession) => {
      if (!ps.sandbox_url || !ps.opencode_session_id) return false;
      const externalId =
        ps.sandbox_url.match(/\/p\/([^/]+)\//)?.[1] || ps.sandbox_id || ps.session_id;
      // The same value switchSandbox derives from `external_id`.
      openedThreadRef.current = {
        sessionId: ps.opencode_session_id,
        sandboxUrl: getSandboxUrl(externalId),
      };
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
      if (freshSessionIdRef.current === ps.session_id) freshSessionIdRef.current = null;
      delete firstMessageRef.current[ps.session_id];
      navigateToSession(ps.opencode_session_id);
      // Deliver the composer's first prompt now that the OpenCode root exists.
      const pending = pendingPromptsRef.current[ps.session_id];
      if (pending) {
        delete pendingPromptsRef.current[ps.session_id];
        void deliverPendingPrompt(ps.sandbox_url, ps.opencode_session_id, pending);
      }
      return true;
    },
    [switchSandbox, navigateToSession]
  );

  // Resolve the session's canonical runtime through the unified /start endpoint,
  // then open the chat. The sandbox can still be warming, so retry patiently.
  const ensuringRef = useRef<string | null>(null);
  // End a connect loop in the inline failure state (web parity: InlineSessionError).
  const failConnect = useCallback((sessionId: string, err: SessionConnectError) => {
    erroredSessionRef.current = sessionId;
    setConnectError(err);
  }, []);
  // Bring a project session online and open it. POST /start is the only open
  // driver: it provisions/resumes runtime, resolves opencode_session_id, and
  // returns a readiness payload. The client only polls that one contract.
  const ensureAndOpen = useCallback(
    async (sessionId: string) => {
      if (!projectId || ensuringRef.current === sessionId) return;
      ensuringRef.current = sessionId;
      const startedAt = Date.now();
      const MAX_WAIT_MS = 4 * 60_000;
      try {
        let attempt = 0;
        let requestFailures = 0;
        while (Date.now() - startedAt < MAX_WAIT_MS) {
          if (ensuringRef.current !== sessionId) return; // superseded by another open
          attempt += 1;

          // ONE server call: POST /start idempotently provisions/resumes the
          // sandbox AND resolves the OpenCode pin server-side.
          let start: SessionStartResult;
          try {
            start = await startProjectSession(projectId, sessionId);
            requestFailures = 0;
          } catch (err) {
            if (getUpgradeGate(err)) throw err; // the outer catch opens the upgrade sheet
            if (ensuringRef.current !== sessionId) return;
            requestFailures += 1;
            const step = connectStepFromRequestError(err, requestFailures);
            if (step.kind === 'fail') {
              failConnect(sessionId, step.failure);
              return;
            }
            log.log(`💓 [connect] attempt ${attempt}: /start failed (${requestFailures}), retrying`);
            await new Promise((r) => setTimeout(r, 1_500));
            continue;
          }
          if (ensuringRef.current !== sessionId) return; // back on project home (goHome)

          const step = connectStepFromStart(start);
          if (step.kind === 'fail') {
            failConnect(sessionId, step.failure);
            return;
          }

          const sandbox = start.sandbox;
          if (step.kind === 'open' && sandbox?.external_id) {
            const sandboxUrl = getSandboxUrl(sandbox.external_id);

            const health = await probeSandboxHealth(sandboxUrl);
            if (ensuringRef.current !== sessionId) return; // back on project home (goHome)

            // Fatal runtime boot failure — stop waiting and surface it with a
            // Restart button (web parity with "OpenCode runtime is not ready").
            if (health.bootError) {
              failConnect(sessionId, {
                title: 'OpenCode runtime is not ready',
                message: 'The sandbox booted, but the project runtime did not become usable.',
                detail: health.bootError,
              });
              return;
            }

            log.log(
              `💓 [connect] attempt ${attempt}: stage=${start.stage} health=${health.status} pin=${start.opencode_session_id ? 'ok' : '-'}`
            );

            if (start.stage === 'ready' && start.opencode_session_id) {
              connectToProjectSession({
                session_id: sessionId,
                sandbox_id: sandbox.sandbox_id,
                sandbox_url: sandboxUrl,
                opencode_session_id: start.opencode_session_id,
                sandbox_provider: sandbox.provider ?? 'daytona',
                created_at: sandbox.created_at,
                updated_at: sandbox.updated_at,
              } as ProjectSession);
              return;
            }
          } else {
            log.log(`💓 [connect] attempt ${attempt}: stage=${start.stage}`);
          }

          await new Promise((r) => setTimeout(r, 1_500));
        }
        failConnect(sessionId, {
          title: 'Could not start session',
          message: 'The session runtime did not become ready in time. Please try again.',
        });
      } catch (err) {
        if (showUpgradeForError(err)) {
          setConnectingProjectSessionId(null);
          return;
        }
        failConnect(sessionId, {
          title: 'Could not start session',
          message: err instanceof Error ? err.message : 'The session runtime could not be started.',
        });
      } finally {
        if (ensuringRef.current === sessionId) ensuringRef.current = null;
      }
    },
    [projectId, connectToProjectSession, failConnect, showUpgradeForError]
  );

  // Open a project session from the list. Always enter the connecting state —
  // ensureAndOpen polls the sandbox endpoint (re-provisioning/waking as needed)
  // before opening, so even a previously-idle session comes back cleanly.
  const handleOpenProjectSession = useCallback(
    (ps: ProjectSession) => {
      haptics.tap();
      releaseWarmSession(ps.session_id);
      navigateToSession(null);
      setConnectError(null);
      erroredSessionRef.current = null;
      // A reopened session, never a fresh one: Cancel must not stop it server-side.
      freshSessionIdRef.current = null;
      setConnectingProjectSessionId(ps.session_id);
    },
    [navigateToSession, releaseWarmSession]
  );

  // Open a session by raw id (e.g. Fix-with-agent returns a new session).
  const handleOpenSessionById = useCallback(
    (sessionId: string) => {
      releaseWarmSession(sessionId);
      navigateToSession(null);
      setConnectError(null);
      erroredSessionRef.current = null;
      freshSessionIdRef.current = null;
      setConnectingProjectSessionId(sessionId);
    },
    [navigateToSession, releaseWarmSession]
  );

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

  // The active tab's project-session row. The tab store's activeSessionId is the
  // OPENCODE root id (connectToProjectSession navigates with
  // ps.opencode_session_id), so resolve back to the Kortix row through the pin —
  // every /projects/:id/sessions/:sid API call needs the Kortix UUID.
  const activeProjectSession = useMemo(
    () =>
      activeSessionId
        ? (projectSessions.find(
            (s) => s.opencode_session_id === activeSessionId || s.session_id === activeSessionId
          ) ?? null)
        : null,
    [projectSessions, activeSessionId]
  );

  // The open thread's sub-agent relation (COR-162): the same relation the
  // session list nests by (`metadata.spawned_by_session`), over the same rows.
  const activeSubAgentRelation = useMemo(
    () => subAgentRelation(activeProjectSession, projectSessions),
    [activeProjectSession, projectSessions]
  );
  const activeSubAgents = useMemo(
    () => (activeProjectSession ? subAgentsOf(activeProjectSession.session_id, projectSessions) : EMPTY_SUB_AGENTS),
    [activeProjectSession, projectSessions]
  );

  // The loading page's header title and first message, so it reads as the
  // thread it becomes: the session's own title once it has one, else the
  // just-sent prompt, else "New session".
  const connectingRow = connectingProjectSessionId
    ? (projectSessions.find((s) => s.session_id === connectingProjectSessionId) ?? null)
    : activeProjectSession;
  const connectingFirstMessage = connectingProjectSessionId
    ? firstMessageRef.current[connectingProjectSessionId]
    : undefined;
  const connectingTitle =
    (connectingRow ? resolveSessionTitle(connectingRow) : null) ?? connectingFirstMessage ?? 'New session';

  // Drive the connecting state. ensureAndOpen polls /start and opens the chat.
  // It guards against concurrent runs, so re-firing on re-render is harmless. A
  // session that ended in an error is skipped so we don't immediately re-loop it;
  // recovery is the explicit Restart button.
  useEffect(() => {
    if (!connectingProjectSessionId) return;
    if (erroredSessionRef.current === connectingProjectSessionId) return;
    void ensureAndOpen(connectingProjectSessionId);
  }, [connectingProjectSessionId, ensureAndOpen]);

  // No thread, page, or overview is on screen: the thread closed (deleted,
  // archived, closed from the overview), another session is connecting, or
  // this project just opened on project home (setScope). Leave the previous
  // session's sandbox, so the live stream never stays on it while the next
  // session connects or after its connect fails. A page opened from a thread
  // keeps the sandbox, as the page reads it (lib/session/session-sandbox).
  const showsSessionContent = showsSessionContentFor({
    activeSessionId,
    activePageId,
    showTabsOverview,
  });
  useEffect(() => {
    if (!showsSessionContent) clearSandbox();
  }, [showsSessionContent, clearSandbox]);

  // Back from a root screen (Settings → Instances switches a sandbox in) to
  // project home: leave that sandbox. The tab store is read at focus time, and
  // a session open in progress (ensuringRef) switches its own sandbox in.
  useFocusEffect(
    useCallback(() => {
      const tabs = useTabStore.getState();
      if (
        leaveSandboxOnFocus({
          activeSessionId: tabs.activeSessionId,
          activePageId: tabs.activePageId,
          showTabsOverview: tabs.showTabsOverview,
          connectInProgress: ensuringRef.current !== null,
        })
      ) {
        clearSandbox();
      }
    }, [clearSandbox])
  );

  // Back from a tool page, a thread, or a connecting session → project home.
  // The view route pops once the store is on project home (ProjectRoutes), and
  // it calls this when Android back, New session, or a drawer route removes
  // it. Stops a running connect loop, so a session that boots later does not
  // reopen the view.
  const goHome = useCallback(() => {
    isHomeRef.current = true;
    returnThreadRef.current = null;
    ensuringRef.current = null;
    openedThreadRef.current = null;
    setConnectingProjectSessionId(null);
    setConnectError(null);
    clearSandbox();
    const tabs = useTabStore.getState();
    if (tabs.showTabsOverview) tabs.setShowTabsOverview(false);
    if (tabs.activeSessionId || tabs.activePageId) tabs.navigateToSession(null);
  }, [clearSandbox]);
  const handleBack = goHome;

  // Back from a tool page. A page and a thread share the view route, and
  // opening a page clears the store's active thread, so the thread is
  // remembered (`returnThreadRef`) and reopened here. The sandbox did not
  // change, so the thread renders at once, with no reconnect. A page opened
  // from project home goes home.
  const returnToThread = useCallback((): boolean => {
    const tabs = useTabStore.getState();
    const returnThreadId = returnThreadRef.current;
    if (pageBackMove({ activePageId: tabs.activePageId, returnThreadId }) !== 'return-to-thread') {
      return false;
    }
    returnThreadRef.current = null;
    tabs.navigateToSession(returnThreadId);
    return true;
  }, []);
  const handlePageBack = useCallback(() => {
    if (!returnToThread()) goHome();
  }, [returnToThread, goHome]);

  // Simplified project-home send flow (ported from web 3f150e0). Creates a
  // project session with the typed prompt as initial_prompt and drops into the
  // connecting state — the effect provisions and opens it once ready.
  const [isDashboardSending, setIsDashboardSending] = useState(false);

  const handleDashboardSend = useCallback(
    async ({ text, files, model, picks, agent }: ProjectHomeSubmit) => {
      if (!projectId || isDashboardSending) return;
      if (!text.trim() && files.length === 0) return;

      setIsDashboardSending(true);
      try {
        // Files must upload into the session's sandbox, which does not exist
        // yet. Those sends stash the prompt and deliver it once the session
        // connects (connectToProjectSession). Text-only sends keep the
        // server-side initial_prompt. The model is baked in at create.
        // A thinking level cannot ride `initial_prompt` (it carries text only),
        // so a text-only send with a level uses web's channel instead:
        // `pending_prompt`, which the server delivers with its model and level
        // (apps/api session-lifecycle/pending-prompt.ts).
        const hasFiles = files.length > 0;
        // Warm path (web parity, `lib/session/warm-session.ts`): the project
        // keeps one session booted while this screen is open. A send on the
        // project defaults claims it with its first prompt, so the sandbox
        // boot is already done. Anything it does not fit, or a refused claim,
        // runs the ordinary create below with the same prompt.
        const warm = warmSessionPool.take(
          projectId,
          { agentName: agent, model, hasFiles },
          { replenish: appIsActive() },
        );
        const claimedWarm =
          warm &&
          (await warmSessionPool.prime(
            projectId,
            warm,
            { text, agent, model: picks?.model ?? null, variant: picks?.variant ?? null },
            agent,
          ))
            ? warm.sessionId
            : null;
        if (claimedWarm) {
          log.log('🔥 [Project] Home send took the warm session');
          void queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) });
        }
        const firstPrompt = hasFiles
          ? {}
          : picks
            ? { pending_prompt: { text, agent, model: picks.model, variant: picks.variant } }
            : { initial_prompt: text };
        const session = claimedWarm
          ? { session_id: claimedWarm }
          : await createProjectSession.mutateAsync({
              ...firstPrompt,
              ...(model ? { opencode_model: model } : {}),
              // The session is bound to this agent; `initial_prompt` runs on it.
              ...(agent ? { agent_name: agent } : {}),
            });
        if (hasFiles) pendingPromptsRef.current[session.session_id] = { text, files, picks, agent };
        // The loading page's first message + "Back to project"'s draft
        // restore both key off this — set for every text send, file or not.
        if (text.trim()) firstMessageRef.current[session.session_id] = text.trim();
        // Enter the connecting state — the effect drives provisioning and opens
        // the server-created session once ready.
        navigateToSession(null);
        setConnectError(null);
        erroredSessionRef.current = null;
        freshSessionIdRef.current = session.session_id;
        setConnectingProjectSessionId(session.session_id);
      } catch (err: any) {
        if (showUpgradeForError(err)) return;
        log.error('❌ [Project] Home send failed:', err?.message || err);
        toast.error(err?.message || 'Failed to start session');
      } finally {
        setIsDashboardSending(false);
      }
    },
    [projectId, isDashboardSending, createProjectSession, navigateToSession, showUpgradeForError, toast, queryClient]
  );

  // The model sheet's Agent tab `+` (thread and home alike): a new session on
  // the shared "configure a new agent" prompt, web's Agents page "New". Same
  // create + connecting path as a project-home send.
  const handleCreateAgent = useCallback(() => {
    handleDashboardSend({ text: newConfigPrompt('agent'), files: [], model: null, picks: null, agent: null });
  }, [handleDashboardSend]);

  // Left drawer open state (ProjectLeftDrawer).
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Stable handlers, so a memoized SessionPage skips parent re-renders.
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Project route stack (ProjectRoutes).
  const [homeKey, setHomeKey] = useState(0);
  // The view route finished its push: home is covered, so remount it with a
  // clean composer (ProjectRoutes `homeKey`). A push that ends AFTER the store
  // already went home — Cancel tapped during the push transition — is not a
  // cover: remounting then would drop the draft Cancel just restored.
  const handleViewCovered = useCallback(() => {
    if (isHomeRef.current) return;
    setHomeKey((key) => key + 1);
  }, []);

  // Cancel the connecting screen (COR-146, always available: the loading
  // checklist and the inline error state both pin it). Stops the client-side
  // connect loop and returns home immediately — never blocked on the network
  // call below. A session THIS screen just created (freshSessionIdRef) is
  // DELETED server-side (the same call as the actions sheet's Delete), so no
  // stopped session keeps the cancelled prompt and a re-send of the restored
  // draft cannot run it twice. A session reopened from the list is never
  // deleted or stopped: it may hold real history the user still wants. If the
  // typed text that started this attempt is still known (a dashboard send), it
  // is restored into the project-home composer (`ProjectHome`'s
  // `takeInitialDraft`, consumed once).
  const handleCancelConnect = useCallback(() => {
    const sid = connectingProjectSessionId;
    haptics.tap();
    const restoreText = sid ? firstMessageRef.current[sid] : undefined;
    const wasFresh = sid !== null && freshSessionIdRef.current === sid;
    if (sid) {
      delete firstMessageRef.current[sid];
      delete pendingPromptsRef.current[sid];
    }
    freshSessionIdRef.current = null;
    if (restoreText) {
      pendingDraftRef.current = restoreText;
      setHomeKey((key) => key + 1);
    }
    goHome();
    if (wasFresh && sid) {
      const refreshLists = () => {
        void queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) });
        void queryClient.invalidateQueries({ queryKey: projectKeys.projectSessionsPaged(projectId) });
      };
      // One retry after 2 s: a dropped request must not leave an orphan
      // session holding the cancelled prompt.
      deleteProjectSession(projectId, sid)
        .catch(() => new Promise((resolve) => setTimeout(resolve, 2_000)).then(() => deleteProjectSession(projectId, sid)))
        .catch((err) => {
          log.warn('⚠️ [connect] Cancel: could not delete the just-created session:', err?.message || err);
        })
        .finally(refreshLists);
    }
  }, [connectingProjectSessionId, goHome, projectId, queryClient]);

  // The top (focused) route of the project stack and its navigation object,
  // captured from the stack's focus events (screenListeners below). This
  // layout's own `useNavigation()` is the root stack and cannot see the
  // project stack; the listener's `navigation` is the project stack screen's
  // (useNavigationBuilder: `descriptors[route.key].navigation`). Refs, not
  // state: nothing renders from them, the drawer and back handler read them
  // when they run. Null until the stack's first focus event (home).
  const topRouteRef = useRef<string | null>(null);
  const topNavigationRef = useRef<NavigationProp<ParamListBase> | null>(null);
  // What the left edge does on the focused route (projectEdgeGesture): the
  // drawer, or back on a sub-page (iOS swipe-back). State, not a ref: the
  // drawer's swipeEnabled renders from it.
  const [edgeGesture, setEdgeGesture] = useState<'drawer' | 'back'>('drawer');
  // This layout's own screen in the root stack (/projects/[id]).
  const navigation = useNavigation();
  const router = useRouter();

  // Back to project home from any project route: reset the store, then pop a
  // covering route. popTo keeps home's params and, when home is not in the
  // stack (a deep link straight to a covering route), replaces the top with it.
  // The view's `beforeRemove` also resets the store; running goHome twice is
  // harmless.
  const returnHome = useCallback(() => {
    goHome();
    const top = topNavigationRef.current;
    if (!top || returnHomeMove(topRouteRef.current) === 'none') return;
    top.dispatch(StackActions.popTo(PROJECT_HOME_ROUTE, undefined, { merge: true }));
  }, [goHome]);

  // The drawer's Sessions, Files, and avatar (Account): push over home,
  // replace the covering route, pop back to it under sub-pages, or reset to
  // [home, route], so the drawer never deepens the stack
  // (lib/session/project-stack). Leaving the view resets the store first, so
  // the new route never mounts while the store still shows a session (a
  // covering route replaces itself with the view when the store is off home).
  // A session row needs no stack move here: home pushes the view, an open
  // view swaps its content, and a covering route replaces itself with the view
  // (useCoveringRoute).
  const navigateProjectRoute = useCallback(
    (route: ProjectDrawerRoute, routeParams?: Record<string, string>) => {
      const top = topNavigationRef.current;
      const stack = top ? top.getState().routes : null;
      const move = drawerRouteMove(stack?.map((r) => r.name) ?? null, route);
      if (move === 'none') return;
      const params = { id: projectId, ...routeParams };
      if (!top || !stack) {
        // No focus event yet: the stack is on project home. `route` is the
        // ProjectDrawerRoute union, so this template literal matches one of
        // the typed router's declared `/projects/[id]/<route>` pathnames.
        router.push({ pathname: `/projects/[id]/${route}`, params });
        return;
      }
      if (move === 'push') {
        top.dispatch(StackActions.push(route, params));
        return;
      }
      if (move === 'pop-to') {
        top.dispatch(StackActions.popTo(route, params, { merge: true }));
        return;
      }
      // replace and reset remove the view when it is in the stack.
      if (stack.some((r) => r.name === PROJECT_VIEW_ROUTE)) goHome();
      if (move === 'replace') {
        top.dispatch(StackActions.replace(route, params));
        return;
      }
      // reset: keep project home mounted (its route object keeps its key).
      top.dispatch(CommonActions.reset(homeAndRoute(stack[0], { name: route, params })));
    },
    [goHome, router, projectId]
  );

  // Push a sub-page over the focused route: project Settings from Settings,
  // Schedules or Secrets from project Settings. Back pops exactly this one.
  // Reads the live stack, not topRouteRef: a double tap lands before the
  // first push's focus event.
  const openSubPage = useCallback(
    (pageId: SubPageId) => {
      const top = topNavigationRef.current;
      if (!top) return;
      const state = top.getState();
      const last = state.routes[state.routes.length - 1];
      const lastPageId = (last?.params as { pageId?: string } | undefined)?.pageId ?? null;
      const move = subPageOpenMove(last ? { name: last.name, pageId: lastPageId } : null, pageId);
      if (move === 'none') return;
      top.dispatch(StackActions.push(PROJECT_PAGE_ROUTE, { id: projectId, pageId }));
    },
    [projectId]
  );

  // Back never leaves the project. iOS: the root stack registers
  // /projects/[id] with swipe-back off (app/_layout.tsx), and the project
  // stack has swipe-back off too: the left edge opens the drawer on every
  // project route. Android back: closes the drawer; on a covering route (the
  // view, Sessions, Files, or Account) returns to project home; on project
  // home it is never allowed to pop to a screen below, and with nothing below
  // the system handles it (app to background).
  // Only the drawer's switcher row (a picked project) leaves this project;
  // the project stack itself never pops below it.
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return undefined;
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        switch (androidBackMove(topRouteRef.current, drawerOpenRef.current)) {
          case 'close-drawer':
            setDrawerOpen(false);
            return true;
          case 'pop':
            // A sub-page: back to the screen it was opened from.
            if (topNavigationRef.current) backFromSubPage(topNavigationRef.current);
            return true;
          case 'pop-home':
            // A page opened over a thread returns to that thread, not to home.
            if (!returnToThread()) returnHome();
            return true;
          case 'home':
            // `navigation` is the root stack: never pop below the project.
            return navigation.canGoBack();
        }
      });
      return () => subscription.remove();
    }, [navigation, returnHome, returnToThread])
  );

  // ── Presentation glue ──

  // The project session on screen (a thread, or a connecting session), by its
  // project session id. The drawer highlights its row.
  const shownSessionId = shownProjectSessionId({
    showTabsOverview,
    activePageId,
    threadSessionId: activeSessionId ? (activeProjectSession?.session_id ?? null) : null,
    connectingSessionId: connectingProjectSessionId,
  });
  const shownSessionIdRef = useRef(shownSessionId);
  shownSessionIdRef.current = shownSessionId;

  // A drawer session row (the drawer has already closed itself). The row of
  // the session on screen does nothing more: reopening it would unmount the
  // thread, show Connecting, and rerun the connect loop.
  const openSessionFromDrawer = useCallback(
    (ps: ProjectSession) => {
      if (drawerSessionRowMove(ps.session_id, shownSessionIdRef.current) === 'close') {
        haptics.tap();
        return;
      }
      handleOpenProjectSession(ps);
    },
    [handleOpenProjectSession]
  );

  // The left drawer. It mounts through renderDrawerContent, so it stays mounted while visually closed.
  // The drawer's gear button is gone (COR-123/COR-160 Task 4): the project
  // Settings page is reached from Settings (drawer avatar) → project row.
  const renderDrawer = useCallback(
    () => (
      <ProjectLeftDrawer
        projectId={projectId}
        activeProjectSessionId={shownSessionId}
        reviewNeedsYouCount={reviewNeedsYouCount}
        // New session opens project home: its composer starts the session.
        onNewSession={returnHome}
        onOpenProjectSession={openSessionFromDrawer}
        onNavigateRoute={navigateProjectRoute}
        onSessionActions={openSessionActions}
        onOpenSwitcher={openSwitcher}
        onClose={closeDrawer}
      />
    ),
    [
      projectId,
      shownSessionId,
      reviewNeedsYouCount,
      returnHome,
      openSessionFromDrawer,
      navigateProjectRoute,
      openSessionActions,
      openSwitcher,
      closeDrawer,
    ]
  );

  // Tool pages keep PageHeader: its hamburger opens the drawer. The "···"
  // that opened the project sheet is removed (COR-123/COR-160 Task 3): the
  // project sheet (`CustomizeSheet`) is deleted, so no page passes
  // `onOpenRightDrawer` any more and `PageHeader` shows no "···".
  const pageChrome = useMemo(
    () => ({
      onOpenDrawer: openDrawer,
      isDrawerOpen: drawerOpen,
    }),
    [openDrawer, drawerOpen]
  );

  // ── Route content ──

  const isHome =
    !scopeReady ||
    (!showTabsOverview && !activePageId && !activeSessionId && !connectingProjectSessionId);
  isHomeRef.current = isHome;

  // The thread renders only once the context holds its sandbox. Until then it
  // shows the connecting view, so SessionPage never starts its sync and
  // queries against the previous or the default sandbox. The gate holds only
  // until the switch first commits: after that the record drops, so a later
  // override (Settings → Instances from the thread) keeps the thread mounted.
  const renderedOpenedThread = openedThreadRef.current;
  const threadReady = threadSandboxReady({
    activeSessionId,
    sandboxUrl,
    openedThread: renderedOpenedThread,
  });
  const keptOpenedThread = pendingOpenedThread({
    activeSessionId,
    sandboxUrl,
    openedThread: renderedOpenedThread,
  });
  useEffect(() => {
    // A connect that recorded a newer thread after this render keeps its record.
    if (openedThreadRef.current === renderedOpenedThread) {
      openedThreadRef.current = keptOpenedThread;
    }
  }, [renderedOpenedThread, keptOpenedThread]);

  // The open page, thread, or connecting session: the view route's content.
  const viewContent = isHome ? null : (
        <View className="flex-1 bg-background">
          {showTabsOverview ? (
          /* Session history grid — opened from the "···" tools menu */
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
        ) : activePageId ? (
          /* Tool page — the SAME page component the legacy screen renders. Its
             PageHeader hamburger opens the drawer. A page that takes `onBack`
             gets goHome: the store returns home and the view route pops. */
          activePageId === 'page:files' && PAGE_TABS[activePageId] ? (
            <Pages.FilesPage
              ref={filesPageRef}
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
              onFileSelectionChange={() => {}}
              onRequestMenu={() => {
                setPageMenuTarget({ page: 'files' });
                pageMenuRef.current?.open();
              }}
            />
          ) : activePageId === 'page:memory' && PAGE_TABS[activePageId] ? (
            <Pages.MemoryPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:secrets' && PAGE_TABS[activePageId] ? (
            <Pages.SecretsPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:connectors' && PAGE_TABS[activePageId] ? (
            <Pages.ConnectorsPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:secrets-nav' && PAGE_TABS[activePageId] ? (
            <Pages.SecretsNavPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:schedules' && PAGE_TABS[activePageId] ? (
            <Pages.SchedulesPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:changes' && PAGE_TABS[activePageId] ? (
            <Pages.ChangesPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:review' && PAGE_TABS[activePageId] ? (
            <Pages.ReviewPage
              page={PAGE_TABS[activePageId]}
              projectId={projectId}
              {...pageChrome}
              onOpenSession={handleOpenSessionById}
            />
          ) : activePageId === 'page:files-nav' && PAGE_TABS[activePageId] ? (
            <Pages.FilesNavPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:dev' && PAGE_TABS[activePageId] ? (
            <Pages.DevPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:settings' && PAGE_TABS[activePageId] ? (
            <Pages.SettingsNavPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:updates' && PAGE_TABS[activePageId] ? (
            <Pages.UpdatesPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:ssh' && PAGE_TABS[activePageId] ? (
            <Pages.SSHPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:running-services' && PAGE_TABS[activePageId] ? (
            <Pages.RunningServicesPage
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
            />
          ) : activePageId === 'page:browser' && PAGE_TABS[activePageId] ? (
            <Pages.BrowserPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:agent-browser' && PAGE_TABS[activePageId] ? (
            <Pages.AgentBrowserPage
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
            />
          ) : activePageId === 'page:connections' && PAGE_TABS[activePageId] ? (
            <Pages.ConnectionsTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
            />
          ) : activePageId === 'page:triggers' && PAGE_TABS[activePageId] ? (
            <Pages.ScheduledTasksTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
            />
          ) : activePageId === 'page:api' && PAGE_TABS[activePageId] ? (
            <Pages.ApiKeysTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
            />
          ) : activePageId === 'page:tunnel' && PAGE_TABS[activePageId] ? (
            <Pages.TunnelTabPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:workspace' && PAGE_TABS[activePageId] ? (
            <Pages.WorkspacePage
              ref={workspacePageRef}
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
              onRequestMenu={() => {
                setPageMenuTarget({ page: 'workspace' });
                pageMenuRef.current?.open();
              }}
              onCreateSessionWithPrompt={handleCreateSessionWithPrompt}
            />
          ) : activePageId === 'page:projects' && PAGE_TABS[activePageId] ? (
            <Pages.ProjectsPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId?.startsWith('page:project:') ? (
            <Pages.ProjectDetailPage
              projectId={activePageId.replace('page:project:', '')}
              onBack={() => {
                useTabStore.getState().navigateToPage('page:projects');
              }}
              {...pageChrome}
            />
          ) : activePageId && PAGE_TABS[activePageId] ? (
            <Pages.PlaceholderPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : null
        ) : activeSessionId && threadReady ? (
          /* Thread — the existing SessionPage, reused verbatim. Its own header
             back returns to project home. The "···" opens the session actions
             sheet for the open thread's project session (COR-140 Task 5);
             hidden until that row has loaded, same as elsewhere a row keyed
             off `activeProjectSession` waits for it. */
          <SessionPage
            sessionId={activeSessionId}
            projectId={projectId}
            onBack={handleBack}
            onOpenDrawer={openDrawer}
            onOpenRightDrawer={
              activeProjectSession ? () => openSessionActions(activeProjectSession) : undefined
            }
            onRenamePress={
              activeProjectSession ? () => openSessionActions(activeProjectSession, 'rename') : undefined
            }
            sessionTitle={activeProjectSession ? sessionDisplayTitle(activeProjectSession) : undefined}
            subAgentRelation={activeSubAgentRelation}
            subAgents={activeSubAgents}
            onOpenProjectSession={handleOpenProjectSession}
            onCreateAgent={handleCreateAgent}
            isDrawerOpen={drawerOpen}
          />
        ) : activeSessionId || connectingProjectSessionId ? (
          /* Connecting — a project session is provisioning (or errored), or
             an opened thread waits for its sandbox to switch in. Same chrome
             as the thread: no top bar, just the floating menu button that
             opens the project drawer. */
          <View style={{ flex: 1 }} className="bg-background">
            <FloatingMenuButton
              onPress={openDrawer}
              title={<SessionThreadTitle title={connectingTitle} />}
            />
            <SessionConnecting
              firstMessage={connectingFirstMessage}
              error={connectError}
              onCancel={handleCancelConnect}
              onRestart={handleRestartSession}
              restarting={restartingSession}
            />
          </View>
        ) : null}
        </View>
  );

  // A sub-page's content (the `page` route): Go back in place of the
  // hamburger, and no drawer. Project Settings opens its Customize rows as
  // further sub-pages.
  const renderSubPage = useCallback(
    (pageId: SubPageId, onBack: () => void) => {
      const page = PAGE_TABS[pageId];
      if (!page) return null;
      switch (pageId) {
        case 'page:settings':
          return (
            <Pages.SettingsNavPage page={page} projectId={projectId} onBack={onBack} onOpenPage={openSubPage} />
          );
        case 'page:schedules':
          return <Pages.SchedulesPage page={page} projectId={projectId} onBack={onBack} />;
        case 'page:secrets-nav':
          return <Pages.SecretsNavPage page={page} projectId={projectId} onBack={onBack} />;
      }
    },
    [projectId, openSubPage]
  );

  // Project home — Kortix symbol, composer.
  const homeContent = (
    <View className="flex-1 bg-background">
      <ProjectHome
        projectId={projectId}
        sending={isDashboardSending}
        onSubmitNewSession={handleDashboardSend}
        onOpenDrawer={openDrawer}
        takeInitialDraft={takeInitialDraft}
      />
    </View>
  );

  const projectRoute: ProjectRouteValue = {
    home: homeContent,
    view: viewContent,
    isHome,
    homeKey,
    goHome,
    newSession: returnHome,
    onViewCovered: handleViewCovered,
    projectId,
    // Stable: a useCallback whose only dependency is a zustand store action.
    openProjectSession: handleOpenProjectSession,
    openDrawer,
    isDrawerOpen: drawerOpen,
    openSessionActions,
    openSubPage,
    renderSubPage,
  };

  // ── Render ──

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Drawer
        open={drawerOpen}
        onOpen={openDrawer}
        onClose={closeDrawer}
        drawerType="slide"
        drawerStyle={{
          width: '100%',
          backgroundColor: 'transparent',
          shadowColor: 'transparent',
          shadowOpacity: 0,
          shadowRadius: 0,
          shadowOffset: { width: 0, height: 0 },
          elevation: 0,
        }}
        overlayStyle={{ backgroundColor: 'transparent' }}
        // The left edge opens the drawer on every project route except a
        // sub-page, where it is the iOS swipe-back: one edge gesture, one
        // meaning per screen. Off while a root screen (Billing, a settings
        // page) covers the project.
        swipeEnabled={isFocused && edgeGesture === 'drawer'}
        swipeEdgeWidth={80}
        swipeMinDistance={30}
        closeSpringConfig={DRAWER_CLOSE_SPRING}
        renderDrawerContent={renderDrawer}>
        <ProjectRouteProvider value={projectRoute}>
          {/* Native Stack: platform default push/pop. No iOS swipe-back: the
              left edge belongs to the drawer on every project route, except
              a sub-page (page), where it goes back. */}
          <Stack
            screenOptions={{
              headerShown: false,
              gestureEnabled: false,
              fullScreenGestureEnabled: false,
            }}
            // The focused route is the top of the stack.
            screenListeners={({ route, navigation: routeNavigation }) => ({
              focus: () => {
                topRouteRef.current = route.name;
                topNavigationRef.current = routeNavigation;
                setEdgeGesture(projectEdgeGesture(route.name));
              },
            })}>
            <Stack.Screen name={PROJECT_HOME_ROUTE} />
            <Stack.Screen name={PROJECT_VIEW_ROUTE} />
            <Stack.Screen name={PROJECT_SESSIONS_ROUTE} />
            <Stack.Screen name={PROJECT_FILES_ROUTE} />
            <Stack.Screen name={PROJECT_ACCOUNT_ROUTE} />
            <Stack.Screen name={PROJECT_PAGE_ROUTE} options={{ gestureEnabled: true }} />
          </Stack>
        </ProjectRouteProvider>
      </Drawer>

      {/* The per-page context menu (Workspace / Files "···"). The project
          sheet (`CustomizeSheet`) it used to sit beside is deleted
          (COR-123/COR-160 Task 3). */}
      <PageContextMenuSheet
        ref={pageMenuRef}
        target={pageMenuTarget}
        workspaceRef={workspacePageRef}
        filesRef={filesPageRef}
        onCreateSessionWithPrompt={handleCreateSessionWithPrompt}
      />

      {/* One session actions sheet (COR-140 Task 5): the thread's "···", the
          Sessions page's long press, and the drawer's session row long press
          all open it through `openSessionActions` (ProjectRouteValue). */}
      <SessionActionsSheet ref={actionsSheetRef} projectId={projectId} poll={isFocused} />

      {/* The project/account switcher (COR-124), opened by the drawer's
          switcher row. A picked project closes the drawer too. */}
      <ProjectSwitcherSheet
        open={switcherOpen}
        accounts={accountsQuery.data ?? []}
        selectedAccountId={project?.account_id ?? null}
        currentProjectId={projectId}
        onClose={closeSwitcher}
        onProjectOpen={closeDrawer}
      />
    </>
  );
}
