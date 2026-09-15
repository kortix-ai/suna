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
 * (index) and the open page, thread, or connecting session (view). Back from
 * any project page returns to project home; back from project home does
 * nothing. Only the menu's All projects opens the Projects list (see
 * ProjectRoutes).
 */

import React, { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { View, Alert, BackHandler, Platform } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModal } from '@gorhom/bottom-sheet';

import { useQueryClient } from '@tanstack/react-query';

import { getAuthToken } from '@/api/config';
import { useSandboxContext } from '@/contexts/SandboxContext';
import {
  useSessions,
  useCreateSession,
  useArchiveSession,
} from '@/lib/platform/hooks';
import { useCompactSession } from '@/lib/opencode/hooks/use-compact-session';
import { useSyncStore } from '@/lib/opencode/sync-store';
import { SessionPage } from '@/components/session/SessionPage';
import { SessionConnecting, type SessionConnectError } from '@/components/session/SessionConnecting';
import { ChevronLeft } from 'lucide-react-native';
import { useFocusEffect, useNavigation } from 'expo-router/react-navigation';
import { useAuthContext } from '@/contexts';
import { useTabStore, PAGE_TABS } from '@/stores/tab-store';
import { useLastProjectStore } from '@/stores/last-project-store';
import { AppStack, usePushTransition } from '@/components/navigation/stack-transitions';
import { PlatformButton } from '@/components/kortix/platform-button';
import {
  PROJECT_VIEW_ROUTE,
  ProjectRouteProvider,
  type ProjectRouteValue,
} from '@/components/session/ProjectRoutes';
import { ExportTranscriptSheet } from '@/components/session/ExportTranscriptSheet';
import { SessionRenameSheet } from '@/components/session/SessionRenameSheet';
import { SessionShareSheet } from '@/components/session/SessionShareSheet';
import { TabsOverview } from '@/components/session/TabsOverview';
import { ProjectHome, type ProjectHomeSubmit } from '@/components/session/ProjectHome';
import { uploadAttachments, withAttachments, type AttachedFile } from '@/lib/session/attachments';
import { ProjectLeftDrawer } from '@/components/session/ProjectLeftDrawer';
import { ProjectDock } from '@/components/session/ProjectDock';
import { ProjectMoreSheet } from '@/components/session/ProjectMoreSheet';
import { ChatActionsSheet } from '@/components/session/ChatActionsSheet';
import {
  PageContextMenuSheet,
  type PageContextMenuTarget,
} from '@/components/session/PageContextMenuSheet';
import { ViewChangesSheet } from '@/components/session/ViewChangesSheet';
import { Drawer } from 'react-native-drawer-layout';
import {
  dockPillLabel,
  type ChatActionGates,
  type ChatActionId,
} from '@/lib/session/dock-menu';
import type { SheetRef } from '@/components/kortix/sheet';
import { haptics } from '@/lib/haptics';
import { log } from '@/lib/logger';
import {
  useProjectSessions,
  useCreateProjectSession,
  useProjectName,
  useChangeRequests,
  projectKeys,
} from '@/lib/projects/hooks';
import {
  startProjectSession,
  restartProjectSession,
  deleteProjectSession,
} from '@/lib/projects/projects-client';
import type { ProjectSession, ProjectSessionStatus } from '@/lib/projects/projects-client';
import { getUpgradeGate } from '@/lib/billing/upgrade-gate';
import { useUpgradeSheetStore } from '@/stores/upgrade-sheet-store';
import { getSandboxUrl } from '@/lib/platform/client';
import type { SandboxProviderName } from '@/lib/platform/client';
import { useTabScreenshotStore } from '@/stores/tab-screenshot-store';

// ── Tool pages (reused verbatim from the legacy page ternary) ──
import { PlaceholderPage } from '@/components/session/PlaceholderPage';
import { UpdatesPage } from '@/components/pages/UpdatesPage';
import { SSHPage } from '@/components/pages/SSHPage';
import { RunningServicesPage } from '@/components/pages/RunningServicesPage';
import { BrowserPage } from '@/components/pages/BrowserPage';
import { FilesPage } from '@/components/pages/FilesPage';
import type { FilesPageRef } from '@/components/pages/FilesPage';
import { ConnectionsTabPage } from '@/components/pages/ConnectionsTabPage';
import { ScheduledTasksTabPage } from '@/components/pages/ScheduledTasksPage';
import { ApiKeysTabPage } from '@/components/pages/ApiKeysPage';
import { ChannelsTabPage } from '@/components/pages/ChannelsPage';
import { TunnelTabPage } from '@/components/pages/TunnelPage';
import { WorkspacePage, type WorkspacePageRef } from '@/components/pages/WorkspacePage';
import { AgentBrowserPage } from '@/components/pages/AgentBrowserPage';
import { SecretsPage } from '@/components/pages/SecretsPage';
import { AgentsPage } from '@/components/pages/AgentsPage';
import { SkillsPage } from '@/components/pages/SkillsPage';
import { CommandsPage } from '@/components/pages/CommandsPage';
import { ConnectorsPage } from '@/components/pages/ConnectorsPage';
import { SecretsNavPage } from '@/components/pages/SecretsNavPage';
import { ChannelsNavPage } from '@/components/pages/ChannelsNavPage';
import { SchedulesPage } from '@/components/pages/SchedulesPage';
import { WebhooksPage } from '@/components/pages/WebhooksPage';
import { ChangesPage } from '@/components/pages/ChangesPage';
import { FilesNavPage } from '@/components/pages/FilesNavPage';
import { SandboxPage } from '@/components/pages/SandboxPage';
import { DevPage } from '@/components/pages/DevPage';
import { SettingsNavPage } from '@/components/pages/SettingsNavPage';
import { MembersNavPage } from '@/components/pages/MembersNavPage';
import { MemoryPage } from '@/components/pages/MemoryPage';
import { LlmProvidersPage } from '@/components/pages/LlmProvidersPage';
import { TerminalPage } from '@/components/pages/TerminalPage';
import { ProjectsPage } from '@/components/pages/ProjectsPage';
import { ProjectDetailPage } from '@/components/pages/ProjectDetailPage';

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
  text: string
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
        body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      }
    );
    if (!res.ok) {
      log.error('[connect] initial prompt failed:', res.status, await res.text().catch(() => ''));
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
}

/**
 * Upload a pending prompt's files into the now-running sandbox, then send the
 * prompt with their `<file>` references. An upload failure still sends the
 * text, like the thread composer.
 */
async function deliverPendingPrompt(
  sandboxUrl: string,
  opencodeSessionId: string,
  { text, files }: PendingPrompt
): Promise<boolean> {
  let fileBlock = '';
  try {
    fileBlock = await uploadAttachments(sandboxUrl, files);
  } catch (err: any) {
    log.error('[connect] attachment upload failed:', err?.message || err);
  }
  return sendOpencodePrompt(sandboxUrl, opencodeSessionId, withAttachments(text, fileBlock));
}

// ─── Main screen ────────────────────────────────────────────────────────────

export function ProjectScreen() {
  const { id: projectId } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();

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

  const { sandboxUrl, switchSandbox } = useSandboxContext();

  // Sheets (web-parity bottom sheets, reused verbatim).
  const exportTranscriptSheetRef = useRef<BottomSheetModal>(null);
  const renameSessionSheetRef = useRef<BottomSheetModal>(null);
  const shareSessionSheetRef = useRef<BottomSheetModal>(null);
  const viewChangesSheetRef = useRef<BottomSheetModal>(null);
  // Dock-raised sheets: the "More…" grid, the chat-actions sheet, and the
  // per-page context menu.
  const moreRef = useRef<SheetRef>(null);
  const chatActionsRef = useRef<SheetRef>(null);
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
  const { data: projectSessions = [] } = useProjectSessions(projectId);
  const [activeProjectSessionId, setActiveProjectSessionId] = useState<string | null>(null);
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
  const loadedProjectName = useProjectName(projectId);
  const openUpgradeSheet = useUpgradeSheetStore((state) => state.openUpgradeSheet);
  const projectName = loadedProjectName || 'Your project';
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
  const archiveSession = useArchiveSession(sandboxUrl);
  const compactSession = useCompactSession();
  const queryClient = useQueryClient();
  // Open change-request count — the "Changes" badge in the More sheet.
  const openCrCount =
    useChangeRequests(projectId ?? null, 'open').data?.change_requests.length ?? 0;

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
      setActiveProjectSessionId(session.session_id);
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

  // Switch the SandboxContext to a session's sandbox and render its chat. Needs
  // both the sandbox URL and the resolved OpenCode pin (opencode_session_id).
  const connectToProjectSession = useCallback(
    (ps: ProjectSession) => {
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
        while (Date.now() - startedAt < MAX_WAIT_MS) {
          if (ensuringRef.current !== sessionId) return; // superseded by another open
          attempt += 1;

          // ONE server call: POST /start idempotently provisions/resumes the
          // sandbox AND resolves the OpenCode pin server-side.
          const start = await startProjectSession(projectId, sessionId);
          if (ensuringRef.current !== sessionId) return; // back on project home (goHome)
          const sandbox = start?.sandbox ?? null;

          if (start?.stage === 'failed' || sandbox?.status === 'error') {
            failConnect(sessionId, {
              title: 'Session failed to start',
              message: 'The sandbox could not be provisioned.',
            });
            return;
          }

          if (sandbox?.status === 'active' && sandbox.external_id) {
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
              `💓 [connect] attempt ${attempt}: stage=${start?.stage} health=${health.status} pin=${start?.opencode_session_id ? 'ok' : '-'}`
            );

            if (start?.stage === 'ready' && start.opencode_session_id) {
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
            log.log(`💓 [connect] attempt ${attempt}: stage=${start?.stage ?? 'provisioning'}`);
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
      setActiveProjectSessionId(ps.session_id);
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
      setActiveProjectSessionId(sessionId);
      navigateToSession(null);
      setConnectError(null);
      erroredSessionRef.current = null;
      setConnectingProjectSessionId(sessionId);
    },
    [navigateToSession]
  );

  // Start an agent-led config session (New / Edit from the Agents/Skills/
  // Commands pages). Mirrors web's useConfigureThread.
  const handleConfigureSession = useCallback(
    async (prompt: string) => {
      if (!projectId) return;
      try {
        haptics.tap();
        const session = await createProjectSession.mutateAsync({ initial_prompt: prompt });
        setActiveProjectSessionId(session.session_id);
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

  // ── Chat-action handlers (ported verbatim from ProjectScreenLegacy) ──

  const handleOpenChangeRequest = useCallback(async () => {
    const ps = activeProjectSession;
    // Target the chat that's on screen (SessionPage is bound to the context
    // sandbox + activeSessionId); the row's pin is only a fallback. Sending to
    // ps.opencode_session_id could hit a session other than the visible one
    // (e.g. a fork), so the prompt would never appear in the open thread.
    const targetSandboxUrl = sandboxUrl || ps?.sandbox_url;
    const targetSessionId = activeSessionId || ps?.opencode_session_id;

    if (!targetSandboxUrl || !targetSessionId) {
      Alert.alert(
        'Open change request',
        'Open a running session before asking the agent to create a change request.'
      );
      return;
    }

    haptics.tap();
    const baseRef = ps?.base_ref || 'main';
    const prompt = `Load the kortix-system skill and read about Versions & Change Requests. Then review the changes in this session, commit them, and open a change request to merge into \`${baseRef}\`. Give it a clear title and a description of what changed and why.`;

    // Optimistic user bubble + busy status, exactly like SessionPage's send —
    // the prompt showing up in the thread IS the confirmation, no alert.
    useSyncStore.getState().addOptimisticMessage(targetSessionId, {
      info: {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        sessionID: targetSessionId,
        time: { created: Date.now() },
      },
      parts: [
        {
          type: 'text',
          id: `prt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          text: prompt,
        },
      ],
    });
    useSyncStore.getState().setStatus(targetSessionId, { type: 'busy' });

    const sent = await sendOpencodePrompt(targetSandboxUrl, targetSessionId, prompt);
    if (!sent) {
      useSyncStore.getState().setStatus(targetSessionId, { type: 'idle' });
      Alert.alert('Could not reach the agent', 'Please try again from the active session.');
    }
  }, [activeProjectSession, sandboxUrl, activeSessionId]);

  const handleRestartActiveSession = useCallback(() => {
    // Kortix id — restartProjectSession, the connecting screen, and
    // ensureAndOpen all operate in the Kortix id space, not the OpenCode one.
    const sid = activeProjectSession?.session_id;
    if (!sid || restartingSession) return;
    Alert.alert(
      'Restart Session',
      'This tears down and re-provisions the session runtime. Your conversation is kept, but anything running in the sandbox (dev servers, terminals) will stop.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restart',
          style: 'destructive',
          onPress: async () => {
            haptics.tap();
            setRestartingSession(true);
            erroredSessionRef.current = sid;
            ensuringRef.current = null;
            setConnectError(null);
            setConnectingProjectSessionId(sid);
            try {
              await restartProjectSession(projectId, sid);
              erroredSessionRef.current = null;
              void ensureAndOpen(sid);
            } catch (err: any) {
              erroredSessionRef.current = sid;
              setConnectError({
                title: 'Restart failed',
                message: err?.message || 'Could not restart the session runtime. Please try again.',
              });
            } finally {
              setRestartingSession(false);
            }
          },
        },
      ]
    );
  }, [activeProjectSession, restartingSession, projectId, ensureAndOpen]);

  // Delete the active session (web parity: deleteProjectSession — destroys the
  // sandbox, the git branch is preserved server-side). API takes the Kortix
  // UUID; the tab is keyed by the OpenCode id, and closeTab (not just
  // deselect) so no dead pill survives in the persisted tab strip.
  const handleDeleteActiveSession = useCallback(() => {
    const ps = activeProjectSession;
    if (!ps) return;
    const title = ps.custom_name || ps.name || 'this session';
    Alert.alert(
      'Delete session?',
      `This will permanently destroy the sandbox for "${title}". This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            haptics.tap();
            try {
              await deleteProjectSession(projectId, ps.session_id);
              if (ps.opencode_session_id) {
                closeTab(ps.opencode_session_id);
              } else if (useTabStore.getState().activeSessionId) {
                navigateToSession(null);
              }
              queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) });
              haptics.success();
            } catch (err: any) {
              haptics.warning();
              Alert.alert('Delete failed', err?.message || 'Could not delete the session.');
            }
          },
        },
      ]
    );
  }, [activeProjectSession, projectId, closeTab, navigateToSession, queryClient]);

  const handleArchive = useCallback(
    (sessionId: string) => {
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
    },
    [archiveSession, navigateToSession]
  );

  const handleCompactSession = useCallback(() => {
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
                }
              );
            },
          },
        ]
      );
    }
  }, [activeSessionId, sandboxUrl, compactSession]);

  // Gating for the chat-actions sheet. Kept memoized: ChatActionsSheet memoizes
  // its item list off this object, so an inline literal would defeat it.
  const chatActionGates: ChatActionGates = useMemo(
    () => ({
      hasSession: !!activeSessionId,
      hasProjectSession: !!activeProjectSession,
      canManageSharing: activeProjectSession?.can_manage_sharing !== false,
    }),
    [activeSessionId, activeProjectSession]
  );

  const handleChatAction = useCallback(
    (id: ChatActionId) => {
      switch (id) {
        case 'rename':
          renameSessionSheetRef.current?.present();
          break;
        case 'share':
          shareSessionSheetRef.current?.present();
          break;
        case 'restart':
          handleRestartActiveSession();
          break;
        case 'export':
          exportTranscriptSheetRef.current?.present();
          break;
        case 'compact':
          handleCompactSession();
          break;
        case 'viewChanges':
          viewChangesSheetRef.current?.present();
          break;
        case 'archive':
          if (activeSessionId) handleArchive(activeSessionId);
          break;
        case 'delete':
          handleDeleteActiveSession();
          break;
      }
    },
    [
      handleRestartActiveSession,
      handleCompactSession,
      handleArchive,
      handleDeleteActiveSession,
      activeSessionId,
    ]
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

  // Back from a tool page, a thread, or a connecting session → project home.
  // The view route pops once the store is on project home (ProjectRoutes), and
  // it calls this when a swipe or system back removes it. Stops a running
  // connect loop, so a session that boots later does not reopen the view.
  const goHome = useCallback(() => {
    ensuringRef.current = null;
    setActiveProjectSessionId(null);
    setConnectingProjectSessionId(null);
    setConnectError(null);
    const tabs = useTabStore.getState();
    if (tabs.showTabsOverview) tabs.setShowTabsOverview(false);
    if (tabs.activeSessionId || tabs.activePageId) tabs.navigateToSession(null);
  }, []);
  const handleBack = goHome;
  const handlePageBack = goHome;

  // Simplified project-home send flow (ported from web 3f150e0). Creates a
  // project session with the typed prompt as initial_prompt and drops into the
  // connecting state — the effect provisions and opens it once ready.
  const [isDashboardSending, setIsDashboardSending] = useState(false);

  const handleDashboardSend = useCallback(
    async ({ text, files, model }: ProjectHomeSubmit) => {
      if (!projectId || isDashboardSending) return;
      if (!text.trim() && files.length === 0) return;

      setIsDashboardSending(true);
      try {
        // Files must upload into the session's sandbox, which does not exist
        // yet. Those sends stash the prompt and deliver it once the session
        // connects (connectToProjectSession). Text-only sends keep the
        // server-side initial_prompt. The model is baked in at create.
        const hasFiles = files.length > 0;
        const session = await createProjectSession.mutateAsync({
          ...(hasFiles ? {} : { initial_prompt: text }),
          ...(model ? { opencode_model: model } : {}),
        });
        if (hasFiles) pendingPromptsRef.current[session.session_id] = { text, files };
        setActiveProjectSessionId(session.session_id);
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

  // Left drawer open state. The drawer itself is added in a later task; this
  // state is here to satisfy ProjectHome's onOpenDrawer callback.
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Project route stack (ProjectRoutes). `viewOpen`: a page, thread, or
  // connecting session is pushed over project home.
  const [viewOpen, setViewOpen] = useState(false);
  const [homeKey, setHomeKey] = useState(0);
  const handleViewCovered = useCallback(() => setHomeKey((key) => key + 1), []);
  const pushTransition = usePushTransition();
  // This layout's own screen in the root stack (/projects/[id]).
  const navigation = useNavigation();
  // Back never leaves the project. iOS: the root stack registers
  // /projects/[id] with swipe-back off (app/_layout.tsx); pages swipe back on
  // the project stack. Android back: closes the drawer, then pops the open
  // page or thread; on project home it is never allowed to pop to a screen
  // below, and with nothing below the system handles it (app to background).
  // Only the menu's All projects opens the Projects list.
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;
  const viewOpenRef = useRef(viewOpen);
  viewOpenRef.current = viewOpen;
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return undefined;
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        if (drawerOpenRef.current) {
          setDrawerOpen(false);
          return true;
        }
        if (viewOpenRef.current) return false; // the project stack pops the view
        return navigation.canGoBack();
      });
      return () => subscription.remove();
    }, [navigation])
  );

  // ── Presentation glue ──

  // The self-contained left drawer. It MUST mount through renderDrawerContent so
  // its subtree (CommandPalette) stays alive while the drawer is visually
  // closed — its rows call onClose() before opening that overlay.
  const renderDrawer = useCallback(
    () => (
      <ProjectLeftDrawer
        projectId={projectId}
        activeProjectSessionId={activeProjectSessionId}
        sessionSandboxUrl={sessionSandboxUrl}
        // New session opens project home: its composer starts the session.
        onNewSession={goHome}
        onOpenProjectSession={handleOpenProjectSession}
        onClose={() => setDrawerOpen(false)}
      />
    ),
    [projectId, activeProjectSessionId, sessionSandboxUrl, goHome, handleOpenProjectSession]
  );

  // Tool pages keep PageHeader. The view route gives it Go back to project
  // home in place of the hamburger; its "···" button opens the dock's menu as
  // a sheet (no floating dock on deep pages).
  const pageChrome = {
    onOpenDrawer: () => setDrawerOpen(true),
    onOpenRightDrawer: () => moreRef.current?.open(),
    isDrawerOpen: drawerOpen,
    isRightDrawerOpen: false,
  };

  // ── Route content ──

  const isHome =
    !scopeReady ||
    (!showTabsOverview && !activePageId && !activeSessionId && !connectingProjectSessionId);

  // The floating dock. On project home it names the project; on a thread it
  // names the chat and adds the long-press actions and the change-request button.
  const renderDock = (inThread: boolean) => (
    <ProjectDock
      label={dockPillLabel({
        inThread,
        chatTitle: inThread
          ? (activeProjectSession?.custom_name ?? activeProjectSession?.name ?? null)
          : null,
        projectName,
      })}
      onNewChat={handleNewSession}
      onNavigate={(pageId) => useTabStore.getState().navigateToPage(pageId)}
      onOpenMore={() => moreRef.current?.open()}
      onLongPressLabel={inThread ? () => chatActionsRef.current?.open() : undefined}
      onOpenChangeRequest={inThread ? () => void handleOpenChangeRequest() : undefined}
    />
  );

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
          /* Tool page — the SAME page component the legacy screen renders. Back
             returns to the thread it was opened from (goBack). */
          activePageId === 'page:files' && PAGE_TABS[activePageId] ? (
            <FilesPage
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
            <MemoryPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:llm-providers' && PAGE_TABS[activePageId] ? (
            <LlmProvidersPage
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
            />
          ) : activePageId === 'page:secrets' && PAGE_TABS[activePageId] ? (
            <SecretsPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:agents' && PAGE_TABS[activePageId] ? (
            <AgentsPage
              page={PAGE_TABS[activePageId]}
              projectId={projectId}
              onConfigure={handleConfigureSession}
              {...pageChrome}
            />
          ) : activePageId === 'page:skills' && PAGE_TABS[activePageId] ? (
            <SkillsPage
              page={PAGE_TABS[activePageId]}
              projectId={projectId}
              onConfigure={handleConfigureSession}
              {...pageChrome}
            />
          ) : activePageId === 'page:commands' && PAGE_TABS[activePageId] ? (
            <CommandsPage
              page={PAGE_TABS[activePageId]}
              projectId={projectId}
              onConfigure={handleConfigureSession}
              {...pageChrome}
            />
          ) : activePageId === 'page:connectors' && PAGE_TABS[activePageId] ? (
            <ConnectorsPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:secrets-nav' && PAGE_TABS[activePageId] ? (
            <SecretsNavPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:channels-nav' && PAGE_TABS[activePageId] ? (
            <ChannelsNavPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:schedules' && PAGE_TABS[activePageId] ? (
            <SchedulesPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:webhooks' && PAGE_TABS[activePageId] ? (
            <WebhooksPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:changes' && PAGE_TABS[activePageId] ? (
            <ChangesPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:files-nav' && PAGE_TABS[activePageId] ? (
            <FilesNavPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:sandbox' && PAGE_TABS[activePageId] ? (
            <SandboxPage
              page={PAGE_TABS[activePageId]}
              projectId={projectId}
              {...pageChrome}
              onOpenSession={handleOpenSessionById}
            />
          ) : activePageId === 'page:dev' && PAGE_TABS[activePageId] ? (
            <DevPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:members' && PAGE_TABS[activePageId] ? (
            <MembersNavPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:settings' && PAGE_TABS[activePageId] ? (
            <SettingsNavPage page={PAGE_TABS[activePageId]} projectId={projectId} {...pageChrome} />
          ) : activePageId === 'page:terminal' && PAGE_TABS[activePageId] ? (
            <TerminalPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:updates' && PAGE_TABS[activePageId] ? (
            <UpdatesPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:ssh' && PAGE_TABS[activePageId] ? (
            <SSHPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:running-services' && PAGE_TABS[activePageId] ? (
            <RunningServicesPage
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
            />
          ) : activePageId === 'page:browser' && PAGE_TABS[activePageId] ? (
            <BrowserPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:agent-browser' && PAGE_TABS[activePageId] ? (
            <AgentBrowserPage
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
            />
          ) : activePageId === 'page:connections' && PAGE_TABS[activePageId] ? (
            <ConnectionsTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
            />
          ) : activePageId === 'page:triggers' && PAGE_TABS[activePageId] ? (
            <ScheduledTasksTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
            />
          ) : activePageId === 'page:api' && PAGE_TABS[activePageId] ? (
            <ApiKeysTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
            />
          ) : activePageId === 'page:channels' && PAGE_TABS[activePageId] ? (
            <ChannelsTabPage
              page={PAGE_TABS[activePageId]}
              onBack={handlePageBack}
              {...pageChrome}
            />
          ) : activePageId === 'page:tunnel' && PAGE_TABS[activePageId] ? (
            <TunnelTabPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:workspace' && PAGE_TABS[activePageId] ? (
            <WorkspacePage
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
            <ProjectsPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId?.startsWith('page:project:') ? (
            <ProjectDetailPage
              projectId={activePageId.replace('page:project:', '')}
              onBack={() => {
                useTabStore.getState().navigateToPage('page:projects');
              }}
              {...pageChrome}
            />
          ) : activePageId && PAGE_TABS[activePageId] ? (
            <PlaceholderPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : null
        ) : activeSessionId ? (
          /* Thread — the existing SessionPage, reused verbatim. Its own header
             back returns to project home; the right-action button surfaces the
             "···" tools menu. */
          <SessionPage
            sessionId={activeSessionId}
            projectName={loadedProjectName}
            onBack={handleBack}
            onOpenDrawer={() => setDrawerOpen(true)}
            chrome="floating"
            isDrawerOpen={drawerOpen}
            isRightDrawerOpen={false}
          />
        ) : connectingProjectSessionId ? (
          /* Connecting — a project session is provisioning (or errored).
             Same chrome as the thread: no top bar, just the floating Go back
             button to project home. */
          <View style={{ flex: 1 }} className="bg-background">
            <View
              className="absolute left-4 z-10"
              style={{ top: insets.top + 8 }}
              pointerEvents="box-none">
              <PlatformButton
                systemImage="chevron.left"
                icon={ChevronLeft}
                fallbackVariant="secondary"
                accessibilityLabel="Go back"
                onPress={() => {
                  haptics.tap();
                  goHome();
                }}
              />
            </View>
            <SessionConnecting
              statusLabel={connectingStatusLabel}
              error={connectError}
              onRestart={handleRestartSession}
              restarting={restartingSession}
            />
          </View>
        ) : null}

          {/* Floating dock over a thread, above the composer. */}
          {activeSessionId && !activePageId && !showTabsOverview ? renderDock(true) : null}
        </View>
  );

  // Project home — Kortix symbol, fixed greeting, composer, dock.
  const homeContent = (
    <View className="flex-1 bg-background">
      <ProjectHome
        projectId={projectId}
        projectName={loadedProjectName}
        sending={isDashboardSending}
        onSubmitNewSession={handleDashboardSend}
        onOpenDrawer={() => setDrawerOpen(true)}
      />
      {renderDock(false)}
    </View>
  );

  const projectRoute: ProjectRouteValue = {
    home: homeContent,
    view: viewContent,
    isHome,
    homeKey,
    goHome,
    onViewOpenChange: setViewOpen,
    onViewCovered: handleViewCovered,
  };

  // ── Render ──

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Drawer
        open={drawerOpen}
        onOpen={() => setDrawerOpen(true)}
        onClose={() => setDrawerOpen(false)}
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
        // While the view is open the left edge is the swipe-back edge.
        swipeEnabled={!viewOpen}
        swipeEdgeWidth={80}
        swipeMinDistance={30}
        renderDrawerContent={renderDrawer}>
        <ProjectRouteProvider value={projectRoute}>
          {/* Same push/pop and swipe-back as every stack (stack-transitions). */}
          <AppStack
            screenOptions={{
              headerShown: false,
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
              ...pushTransition,
            }}>
            <AppStack.Screen name="index" />
            <AppStack.Screen name={PROJECT_VIEW_ROUTE} />
          </AppStack>
        </ProjectRouteProvider>
      </Drawer>

      {/* Dock-raised sheets — the "More…" grid, the chat-actions sheet, and the
          per-page context menu. ProjectMoreSheet supersedes the old ToolsMenuSheet. */}
      <ProjectMoreSheet
        ref={moreRef}
        onNavigate={(pageId) => useTabStore.getState().navigateToPage(pageId)}
        changesBadgeCount={openCrCount}
      />

      <ChatActionsSheet
        ref={chatActionsRef}
        title={activeProjectSession?.custom_name ?? activeProjectSession?.name ?? 'This chat'}
        gates={chatActionGates}
        onAction={handleChatAction}
      />

      <PageContextMenuSheet
        ref={pageMenuRef}
        target={pageMenuTarget}
        workspaceRef={workspacePageRef}
        filesRef={filesPageRef}
        onCreateSessionWithPrompt={handleCreateSessionWithPrompt}
      />

      <ViewChangesSheet ref={viewChangesSheetRef} sessionId={activeSessionId} />

      <ExportTranscriptSheet ref={exportTranscriptSheetRef} sessionId={activeSessionId} />
      <SessionRenameSheet
        ref={renameSessionSheetRef}
        projectId={projectId}
        session={activeProjectSession}
      />
      <SessionShareSheet
        ref={shareSessionSheetRef}
        projectId={projectId}
        session={activeProjectSession}
      />
    </>
  );
}
