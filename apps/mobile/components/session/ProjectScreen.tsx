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
 * (index) and at most one covering route: the open page, thread, or
 * connecting session (view), Sessions, Files, or Account. Every project page
 * shows the hamburger, and the drawer opens on every project route. Android
 * back from a covering route returns to project home; back from project home
 * does nothing. Only the menu's All projects opens the Projects list (see
 * ProjectRoutes).
 */

import React, { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { View, Alert, BackHandler, Platform } from 'react-native';
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';

import { getAuthToken } from '@/api/config';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useSessions, useCreateSession } from '@/lib/platform/hooks';
import { SessionPage } from '@/components/session/SessionPage';
import { SessionConnecting, type SessionConnectError } from '@/components/session/SessionConnecting';
import {
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
  PROJECT_SESSIONS_ROUTE,
  PROJECT_VIEW_ROUTE,
  ProjectRouteProvider,
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
  type ProjectDrawerRoute,
} from '@/lib/session/project-stack';
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
import { ProjectLeftDrawer } from '@/components/session/ProjectLeftDrawer';
import { ProjectHeaderActions } from '@/components/session/ProjectHeaderActions';
import { CustomizeSheet } from '@/components/session/CustomizeSheet';
import {
  PageContextMenuSheet,
  type PageContextMenuTarget,
} from '@/components/session/PageContextMenuSheet';
import { Drawer } from 'react-native-drawer-layout';
import type { SheetRef } from '@/components/kortix/sheet';
import { haptics } from '@/lib/haptics';
import { log } from '@/lib/logger';
import {
  useProjectSessions,
  useCreateProjectSession,
} from '@/lib/projects/hooks';
import { useReviewItems } from '@/lib/review/use-review';
import { countReviewItemsBySegment } from '@kortix/sdk';
import {
  startProjectSession,
  restartProjectSession,
} from '@/lib/projects/projects-client';
import type {
  ProjectSession,
  ProjectSessionStatus,
  SessionStartResult,
} from '@/lib/projects/projects-client';
import { connectStepFromRequestError, connectStepFromStart } from '@/lib/session/connect-step';
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
  get AgentsPage(): typeof import('@/components/pages/AgentsPage').AgentsPage {
    return require('@/components/pages/AgentsPage').AgentsPage;
  },
  get SkillsPage(): typeof import('@/components/pages/SkillsPage').SkillsPage {
    return require('@/components/pages/SkillsPage').SkillsPage;
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
  get WebhooksPage(): typeof import('@/components/pages/WebhooksPage').WebhooksPage {
    return require('@/components/pages/WebhooksPage').WebhooksPage;
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
  get MembersNavPage(): typeof import('@/components/pages/MembersNavPage').MembersNavPage {
    return require('@/components/pages/MembersNavPage').MembersNavPage;
  },
  get MemoryPage(): typeof import('@/components/pages/MemoryPage').MemoryPage {
    return require('@/components/pages/MemoryPage').MemoryPage;
  },
  get TerminalPage(): typeof import('@/components/pages/TerminalPage').TerminalPage {
    return require('@/components/pages/TerminalPage').TerminalPage;
  },
  get ProjectsPage(): typeof import('@/components/pages/ProjectsPage').ProjectsPage {
    return require('@/components/pages/ProjectsPage').ProjectsPage;
  },
  get ProjectDetailPage(): typeof import('@/components/pages/ProjectDetailPage').ProjectDetailPage {
    return require('@/components/pages/ProjectDetailPage').ProjectDetailPage;
  },
};

// ─── Module-local helpers (copied verbatim from ProjectScreenLegacy) ─────────

const PROJECT_SESSION_STATUS_LABELS: Record<ProjectSessionStatus, string> = {
  queued: 'Queued',
  branching: 'Branching',
  provisioning: 'Provisioning',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  completed: 'Completed',
};

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

  // The "More…" grid (opened from a tool page's PageHeader "···" button) and
  // the per-page context menu.
  const customizeSheetRef = useRef<SheetRef>(null);
  const pageMenuRef = useRef<SheetRef>(null);
  const [pageMenuTarget, setPageMenuTarget] = useState<PageContextMenuTarget | null>(null);
  // Page refs (some tool pages drive imperative actions).
  const filesPageRef = useRef<FilesPageRef>(null);
  const workspacePageRef = useRef<WorkspacePageRef>(null);

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
  // Sessions whose connect loop ended in an error — guards the auto-connect
  // effect from immediately re-driving (and re-looping) a known-failed session.
  const erroredSessionRef = useRef<string | null>(null);
  const createProjectSession = useCreateProjectSession(projectId);
  const openUpgradeSheet = useUpgradeSheetStore((state) => state.openUpgradeSheet);
  const connectingStatusLabel = useMemo(() => {
    const ps = projectSessions.find((s) => s.session_id === connectingProjectSessionId);
    return `${(ps && PROJECT_SESSION_STATUS_LABELS[ps.status]) || 'Provisioning'}…`;
  }, [projectSessions, connectingProjectSessionId]);

  // Only touch a sandbox once a session is actually open (its sandbox is switched
  // in via connectToProjectSession). On the project home there is no authorized
  // sandbox — keep the OpenCode/Kortix proxy hooks disabled to avoid 403s.
  const sessionSandboxUrl = activeSessionId ? sandboxUrl : undefined;
  const { data: sessions = [] } = useSessions(sessionSandboxUrl);
  const createSession = useCreateSession(sandboxUrl);
  // Review items that wait for the user — the Review row's value in the project
  // sheet. Open change requests are among them (the API adapts them into the list).
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
      setConnectingProjectSessionId(session.session_id);
    } catch (err: any) {
      if (showUpgradeForError(err)) return;
      log.error('❌ [Project] Failed to create session:', err?.message || err);
      Alert.alert('Error', err?.message || 'Failed to create session');
    }
  }, [projectId, createProjectSession, navigateToSession, showUpgradeForError]);

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
      navigateToSession(null);
      setConnectError(null);
      erroredSessionRef.current = null;
      setConnectingProjectSessionId(ps.session_id);
    },
    [navigateToSession]
  );

  // Open a session by raw id (e.g. Fix-with-agent returns a new session).
  const handleOpenSessionById = useCallback(
    (sessionId: string) => {
      navigateToSession(null);
      setConnectError(null);
      erroredSessionRef.current = null;
      setConnectingProjectSessionId(sessionId);
    },
    [navigateToSession]
  );

  // Start an agent-led config session (New / Edit from the Agents and Skills
  // pages). Mirrors web's useConfigureThread.
  const handleConfigureSession = useCallback(
    async (prompt: string) => {
      if (!projectId) return;
      try {
        haptics.tap();
        const session = await createProjectSession.mutateAsync({ initial_prompt: prompt });
        navigateToSession(null);
        setConnectError(null);
        erroredSessionRef.current = null;
        setConnectingProjectSessionId(session.session_id);
      } catch (err: any) {
        if (showUpgradeForError(err)) return;
        log.error('❌ [Project] Failed to start config session:', err?.message || err);
        Alert.alert('Error', err?.message || 'Failed to start session');
      }
    },
    [projectId, createProjectSession, navigateToSession, showUpgradeForError]
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
        const firstPrompt = hasFiles
          ? {}
          : picks
            ? { pending_prompt: { text, agent, model: picks.model, variant: picks.variant } }
            : { initial_prompt: text };
        const session = await createProjectSession.mutateAsync({
          ...firstPrompt,
          ...(model ? { opencode_model: model } : {}),
          // The session is bound to this agent; `initial_prompt` runs on it.
          ...(agent ? { agent_name: agent } : {}),
        });
        if (hasFiles) pendingPromptsRef.current[session.session_id] = { text, files, picks, agent };
        // Enter the connecting state — the effect drives provisioning and opens
        // the server-created session once ready.
        navigateToSession(null);
        setConnectError(null);
        erroredSessionRef.current = null;
        setConnectingProjectSessionId(session.session_id);
      } catch (err: any) {
        if (showUpgradeForError(err)) return;
        log.error('❌ [Project] Home send failed:', err?.message || err);
        Alert.alert('Error', err?.message || 'Failed to start session');
      } finally {
        setIsDashboardSending(false);
      }
    },
    [projectId, isDashboardSending, createProjectSession, navigateToSession, showUpgradeForError]
  );

  // Left drawer open state (ProjectLeftDrawer).
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Stable handlers, so a memoized SessionPage skips parent re-renders.
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const openCustomizeSheet = useCallback(() => customizeSheetRef.current?.open(), []);

  // Project route stack (ProjectRoutes).
  const [homeKey, setHomeKey] = useState(0);
  const handleViewCovered = useCallback(() => setHomeKey((key) => key + 1), []);
  // The top (focused) route of the project stack and its navigation object,
  // captured from the stack's focus events (screenListeners below). This
  // layout's own `useNavigation()` is the root stack and cannot see the
  // project stack; the listener's `navigation` is the project stack screen's
  // (useNavigationBuilder: `descriptors[route.key].navigation`). Refs, not
  // state: nothing renders from them, the drawer and back handler read them
  // when they run. Null until the stack's first focus event (home).
  const topRouteRef = useRef<string | null>(null);
  const topNavigationRef = useRef<NavigationProp<ParamListBase> | null>(null);
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

  // The drawer's Sessions, Files, and avatar (Account): push over home, or
  // replace the covering route so the stack stays one screen deep
  // (lib/session/project-stack). Leaving the view resets the store first, so
  // the new route never mounts while the store still shows a session (a
  // covering route replaces itself with the view when the store is off home).
  // A session row needs no stack move here: home pushes the view, an open
  // view swaps its content, and a covering route replaces itself with the view
  // (useCoveringRoute).
  const navigateProjectRoute = useCallback(
    (route: ProjectDrawerRoute) => {
      const move = drawerRouteMove(topRouteRef.current, route);
      if (move === 'none') return;
      const params = { id: projectId };
      const top = topNavigationRef.current;
      if (!top) {
        // No focus event yet: the stack is on project home.
        router.push(`/projects/${projectId}/${route}`);
        return;
      }
      if (move === 'push') {
        top.dispatch(StackActions.push(route, params));
        return;
      }
      if (topRouteRef.current === PROJECT_VIEW_ROUTE) goHome();
      top.dispatch(StackActions.replace(route, params));
    },
    [goHome, router, projectId]
  );

  // Back never leaves the project. iOS: the root stack registers
  // /projects/[id] with swipe-back off (app/_layout.tsx), and the project
  // stack has swipe-back off too: the left edge opens the drawer on every
  // project route. Android back: closes the drawer; on a covering route (the
  // view, Sessions, Files, or Account) returns to project home; on project
  // home it is never allowed to pop to a screen below, and with nothing below
  // the system handles it (app to background).
  // Only the menu's All projects opens the Projects list.
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
  // The drawer's gear button (top right of the logo): opens the project
  // settings page. `navigateToPage` alone is enough regardless of which
  // project route is focused — leaving the store's home state pushes or
  // replaces the covering route with `view` (ProjectHomeRoute / useCoveringRoute).
  const openProjectSettings = useCallback(() => {
    useTabStore.getState().navigateToPage('page:settings');
  }, []);

  const renderDrawer = useCallback(
    () => (
      <ProjectLeftDrawer
        projectId={projectId}
        activeProjectSessionId={shownSessionId}
        // New session opens project home: its composer starts the session.
        onNewSession={returnHome}
        onOpenProjectSession={openSessionFromDrawer}
        onNavigateRoute={navigateProjectRoute}
        onOpenSettings={openProjectSettings}
        onClose={closeDrawer}
      />
    ),
    [projectId, shownSessionId, returnHome, openSessionFromDrawer, navigateProjectRoute, openProjectSettings, closeDrawer]
  );

  // Tool pages keep PageHeader: its hamburger opens the drawer, and its "···"
  // button opens the project sheet (CustomizeSheet), the same sheet the
  // floating header's "···" opens on project home and in a thread.
  const pageChrome = useMemo(
    () => ({
      onOpenDrawer: openDrawer,
      onOpenRightDrawer: openCustomizeSheet,
      isDrawerOpen: drawerOpen,
      isRightDrawerOpen: false,
    }),
    [openDrawer, openCustomizeSheet, drawerOpen]
  );

  // ── Route content ──

  const isHome =
    !scopeReady ||
    (!showTabsOverview && !activePageId && !activeSessionId && !connectingProjectSessionId);

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
          ) : activePageId === 'page:agents' && PAGE_TABS[activePageId] ? (
            <Pages.AgentsPage
              page={PAGE_TABS[activePageId]}
              projectId={projectId}
              onConfigure={handleConfigureSession}
              {...pageChrome}
            />
          ) : activePageId === 'page:skills' && PAGE_TABS[activePageId] ? (
            <Pages.SkillsPage
              page={PAGE_TABS[activePageId]}
              projectId={projectId}
              onConfigure={handleConfigureSession}
              {...pageChrome}
            />
          ) : activePageId === 'page:connectors' && PAGE_TABS[activePageId] ? (
            <Pages.ConnectorsPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:secrets-nav' && PAGE_TABS[activePageId] ? (
            <Pages.SecretsNavPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:schedules' && PAGE_TABS[activePageId] ? (
            <Pages.SchedulesPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:webhooks' && PAGE_TABS[activePageId] ? (
            <Pages.WebhooksPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
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
          ) : activePageId === 'page:members' && PAGE_TABS[activePageId] ? (
            <Pages.MembersNavPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:settings' && PAGE_TABS[activePageId] ? (
            <Pages.SettingsNavPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:terminal' && PAGE_TABS[activePageId] ? (
            <Pages.TerminalPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
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
             back returns to project home; the right-action button surfaces the
             "···" tools menu. */
          <SessionPage
            sessionId={activeSessionId}
            projectId={projectId}
            onBack={handleBack}
            onOpenDrawer={openDrawer}
            onOpenRightDrawer={openCustomizeSheet}
            chrome="floating"
            isDrawerOpen={drawerOpen}
            isRightDrawerOpen={false}
          />
        ) : activeSessionId || connectingProjectSessionId ? (
          /* Connecting — a project session is provisioning (or errored), or
             an opened thread waits for its sandbox to switch in. Same chrome
             as the thread: no top bar, just the floating menu button that
             opens the project drawer. */
          <View style={{ flex: 1 }} className="bg-background">
            <FloatingMenuButton onPress={openDrawer}>
              <ProjectHeaderActions onOpenMore={openCustomizeSheet} />
            </FloatingMenuButton>
            <SessionConnecting
              statusLabel={connectingStatusLabel}
              error={connectError}
              onRestart={handleRestartSession}
              restarting={restartingSession}
            />
          </View>
        ) : null}
        </View>
  );

  // Project home — Kortix symbol, composer.
  const homeContent = (
    <View className="flex-1 bg-background">
      <ProjectHome
        projectId={projectId}
        sending={isDashboardSending}
        onSubmitNewSession={handleDashboardSend}
        onOpenDrawer={openDrawer}
        onOpenMore={openCustomizeSheet}
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
    openCustomizeSheet,
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
        // The left edge opens the drawer on every project route: the project
        // stack has no swipe-back, so one edge gesture has one meaning. Off
        // while a root screen (Billing, a settings page) covers the project.
        swipeEnabled={isFocused}
        swipeEdgeWidth={80}
        swipeMinDistance={30}
        closeSpringConfig={DRAWER_CLOSE_SPRING}
        renderDrawerContent={renderDrawer}>
        <ProjectRouteProvider value={projectRoute}>
          {/* Native Stack: platform default push/pop. No iOS swipe-back: the
              left edge belongs to the drawer on every project route. */}
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
              },
            })}>
            <Stack.Screen name={PROJECT_HOME_ROUTE} />
            <Stack.Screen name={PROJECT_VIEW_ROUTE} />
            <Stack.Screen name={PROJECT_SESSIONS_ROUTE} />
            <Stack.Screen name={PROJECT_FILES_ROUTE} />
            <Stack.Screen name={PROJECT_ACCOUNT_ROUTE} />
          </Stack>
        </ProjectRouteProvider>
      </Drawer>

      {/* The project sheet and the per-page context menu. The sheet's Review
          row carries the count of items that wait for the user. */}
      <CustomizeSheet
        ref={customizeSheetRef}
        onNavigate={(pageId) => useTabStore.getState().navigateToPage(pageId)}
        reviewBadgeCount={reviewNeedsYouCount}
      />

      <PageContextMenuSheet
        ref={pageMenuRef}
        target={pageMenuTarget}
        workspaceRef={workspacePageRef}
        filesRef={filesPageRef}
        onCreateSessionWithPrompt={handleCreateSessionWithPrompt}
      />
    </>
  );
}
