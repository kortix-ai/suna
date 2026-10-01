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
import { useProjectSessionConnect } from '@/lib/session/project-connect';
import { useProjectHomeSend } from '@/components/session/use-project-home-send';
import { useProjectStack } from '@/components/session/use-project-stack';
import { View } from 'react-native';
import { Stack, useIsFocused, useLocalSearchParams } from 'expo-router';

import { useSandboxContext } from '@/contexts/SandboxContext';
import { SessionPage } from '@/components/session/SessionPage';
import { SessionConnecting } from '@/components/session/SessionConnecting';
import { SessionThreadTitle } from '@/components/session/SessionThreadTitle';
import { appIsActive, useWarmProjectSession } from '@/hooks/useWarmProjectSession';
import { warmSessionPool } from '@/lib/session/warm-session-pool';
import { useAuthContext } from '@/contexts';
import { usePushStore } from '@/stores/push-store';
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
  type ProjectRouteValue,
} from '@/components/session/ProjectRoutes';
import { FloatingMenuButton } from '@/components/session/FloatingMenuButton';
import {
  pageBackMove,
  drawerSessionRowMove,
  drawerThreadMove,
  shownProjectSessionId,
  projectEdgeGesture,
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
import { ProjectHome } from '@/components/session/ProjectHome';
import {
  resolveSessionTitle,
  sessionDisplayTitle,
  subsessionTitle,
} from '@/lib/session/session-list';
import { subAgentRelation, subAgentsOf } from '@/lib/session/sub-agents';
import { ProjectLeftDrawer } from '@/components/session/ProjectLeftDrawer';
import {
  SessionActionsSheet,
  type SessionActionsInitialView,
  type SessionActionsSheetRef,
} from '@/components/session/SessionActionsSheet';
import { Drawer } from 'react-native-drawer-layout';
import { haptics } from '@/lib/haptics';
import {
  useAccounts,
  useProject,
  useProjectSessions,
} from '@/lib/projects/hooks';
import { DRAWER_CLOSE, DRAWER_OPEN } from '@/lib/ui/drawer-springs';
import { useReviewItems } from '@/lib/review/use-review';
import { needsYouBySession } from '@/lib/session/needs-you';
import {
  countReviewItemsBySegment,
  runtimeSessionsOf,
  SESSION_NOTICE,
  sessionConnectionLabel,
  sessionParentId,
} from '@kortix/sdk';
import { queuePromptWhileWaking } from '@/lib/session/connecting-send';
import { loadSavedCopy } from '@/lib/session/saved-copy';
import * as Crypto from 'expo-crypto';
import type { ProjectSession } from '@/lib/projects/projects-client';
import { useSyncStore } from '@/lib/opencode/sync-store';
import { getSandboxUrl } from '@/lib/platform/client';
import type { SandboxProviderName } from '@/lib/platform/client';

// ── Tool pages (reused verbatim from the legacy page ternary) ──

// A tool page renders only while it is the open page, so its module is required
// on first render, not when the app starts. Metro's `require` is synchronous:
// no Suspense boundary and no fallback flash. Modules are cached after the
// first call, so each later access is a lookup.
const Pages = {
  get BrowserPage(): typeof import('@/components/pages/BrowserPage').BrowserPage {
    return require('@/components/pages/BrowserPage').BrowserPage;
  },
  get SecretsNavPage(): typeof import('@/components/pages/SecretsNavPage').SecretsNavPage {
    return require('@/components/pages/SecretsNavPage').SecretsNavPage;
  },
  get MembersNavPage(): typeof import('@/components/pages/MembersNavPage').MembersNavPage {
    return require('@/components/pages/MembersNavPage').MembersNavPage;
  },
  get SchedulesPage(): typeof import('@/components/pages/SchedulesPage').SchedulesPage {
    return require('@/components/pages/SchedulesPage').SchedulesPage;
  },
  get ReviewPage(): typeof import('@/components/pages/ReviewPage').ReviewPage {
    return require('@/components/pages/ReviewPage').ReviewPage;
  },
  get SettingsNavPage(): typeof import('@/components/pages/SettingsNavPage').SettingsNavPage {
    return require('@/components/pages/SettingsNavPage').SettingsNavPage;
  },
  get MemoryPage(): typeof import('@/components/pages/MemoryPage').MemoryPage {
    return require('@/components/pages/MemoryPage').MemoryPage;
  },
  get ProjectDetailPage(): typeof import('@/components/pages/ProjectDetailPage').ProjectDetailPage {
    return require('@/components/pages/ProjectDetailPage').ProjectDetailPage;
  },
};

// ─── Module-local helpers (copied verbatim from ProjectScreenLegacy) ─────────


// ─── Main screen ────────────────────────────────────────────────────────────

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

  const { sandboxUrl, clearSandbox } = useSandboxContext();
  // Polls pause while a root screen (Account, settings) covers the project.
  const isFocused = useIsFocused();

  // The session actions sheet (COR-140 Task 5): one instance for the thread's
  // "···", the Sessions page's long press, and the drawer's session row long
  // press. `openSessionActions` goes on ProjectRouteValue, so every consumer
  // reaches it without its own state.
  const actionsSheetRef = useRef<SessionActionsSheetRef>(null);
  // `initialView` (COR-140): the thread header's title tap opens this same
  // sheet straight to Rename, and its Share button straight to Share
  // (KRTX-248), instead of a second implementation of either.
  const openSessionActions = useCallback((session: ProjectSession, initialView?: SessionActionsInitialView) => {
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

  // Data
  // Repo-first project sessions (web model): GET /projects/:id/sessions.
  const { data: projectSessions = [] } = useProjectSessions(projectId, { poll: isFocused });

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
  const {
    connectingProjectSessionId, connectError, restartingSession,
    connectingRow, connectingFirstPrompt, connectingTitle, activeProjectSession,
    openedThreadRef, openedProjectSessionIdsRef, pendingThreadFocusRef, returnThreadRef,
    isHomeRef, ensuringRef, navigateToSession, goHome, refreshSessionLists,
    firstPromptRef, freshSessionIdRef, erroredSessionRef, setConnectError, setConnectingProjectSessionId, showUpgradeForError,
    handleOpenProjectSession, handleOpenSessionById, handleRestartSession,
    handleCancelConnect, takeInitialDraft,
  } = useProjectSessionConnect(projectId, projectSessions, activeSessionId, activePageId, releaseWarmSession, setHomeKey);

  // Review items that wait for the user. The project sheet that used to show
  // this as its Review row's badge is deleted (COR-123/COR-160 Task 3); the
  // drawer's Review row carries the same count now (Task 4). Open change
  // requests are among them (the API adapts them into the list).
  const reviewItems = useReviewItems(projectId ?? null, { poll: isFocused });
  const reviewNeedsYouCount = useMemo(
    () => countReviewItemsBySegment(reviewItems.data ?? []).needs_you,
    [reviewItems.data]
  );
  // The same items per originating session: the drawer's Needs you group.
  const needsYouSessions = useMemo(() => needsYouBySession(reviewItems.data ?? []), [reviewItems.data]);


  // ── Handlers (copied verbatim from ProjectScreenLegacy) ──




  // The thread shows a sub-session of that row, not its root: the header
  // reads the sub-session's title and the title tap (rename of the project
  // session) is off.
  const activeSubsession = useMemo(
    () =>
      activeProjectSession &&
      activeSessionId &&
      activeSessionId !== (activeProjectSession.runtime_session_id ?? activeProjectSession.opencode_session_id)
        ? (runtimeSessionsOf(activeProjectSession).find((item) => item.id === activeSessionId) ?? null)
        : null,
    [activeProjectSession, activeSessionId]
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


  const { isDashboardSending, handleDashboardSend, handleCreateAgent } = useProjectHomeSend(projectId, {
    refreshSessionLists, firstPromptRef, navigateToSession, setConnectError,
    erroredSessionRef, freshSessionIdRef, setConnectingProjectSessionId, showUpgradeForError,
  });
  // Left drawer open state (ProjectLeftDrawer).
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Stable handlers, so a memoized SessionPage skips parent re-renders.
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const { topRouteRef, topNavigationRef, edgeGesture, setEdgeGesture, replaceProject, returnHome, navigateProjectRoute, openSubPage } = useProjectStack(
    projectId, goHome, returnToThread, drawerOpen, setDrawerOpen,
  );

  // ── Presentation glue ──

  // The project session on screen (a thread, or a connecting session), by its
  // project session id. The drawer highlights its row.
  const shownSessionId = shownProjectSessionId({
    activePageId,
    threadSessionId: activeSessionId ? (activeProjectSession?.session_id ?? null) : null,
    connectingSessionId: connectingProjectSessionId,
  });
  const shownSessionIdRef = useRef(shownSessionId);
  shownSessionIdRef.current = shownSessionId;
  // The OpenCode id the thread on screen shows (null under a tool page or
  // while connecting): which drawer sub-session row is highlighted.
  const shownOpenCodeId = shownSessionId && !activePageId ? activeSessionId : null;
  const shownOpenCodeIdRef = useRef(shownOpenCodeId);
  shownOpenCodeIdRef.current = shownOpenCodeId;

  // Push (components/notifications/PushNotificationsBridge): the session on
  // screen suppresses its own notification banner while this project is on top.
  useEffect(() => {
    usePushStore.getState().setViewingSessionId(isFocused ? shownSessionId : null);
  }, [isFocused, shownSessionId]);
  useEffect(() => () => usePushStore.getState().setViewingSessionId(null), []);

  // A tapped notification for this project: open its session, the same path
  // as the Sessions page. The session already on screen stays as it is.
  const pushOpen = usePushStore((s) => s.pendingOpen);
  useEffect(() => {
    if (!pushOpen || !projectId || !scopeReady || !isFocused) return;
    const open = usePushStore.getState().takeOpen(projectId);
    if (!open) return;
    if (drawerSessionRowMove(open.sessionId, shownSessionIdRef.current) === 'open') {
      handleOpenSessionById(open.sessionId);
    }
  }, [pushOpen, projectId, scopeReady, isFocused, handleOpenSessionById]);

  // A drawer row (the drawer has already closed itself) that targets one
  // OpenCode session of `ps`: its root (a session row) or a sub-session (a
  // row under it). Another session opens through the connect path. On the
  // session on screen, another OpenCode session of it only swaps the thread's
  // active id — the same sandbox, no reconnect (the task tool's View does the
  // same) — and the one already showing does nothing more: reopening it would
  // unmount the thread, show Connecting, and rerun the connect loop. While
  // the session on screen still connects, the target waits for the thread
  // (`queue`). A sub-session row of another session opens that session and
  // then shows the sub-session (`handleOpenProjectSession` focus).
  const openThreadFromDrawer = useCallback(
    (ps: ProjectSession, targetOpenCodeId: string | null) => {
      const move = drawerThreadMove({
        rowSessionId: ps.session_id,
        targetOpenCodeId,
        shownSessionId: shownSessionIdRef.current,
        activeOpenCodeId: shownOpenCodeIdRef.current,
      });
      if (move === 'open') {
        // A sub-session row: open its parent, then show the sub-session.
        const focus = targetOpenCodeId && targetOpenCodeId !== ps.opencode_session_id ? targetOpenCodeId : undefined;
        handleOpenProjectSession(ps, focus);
        return;
      }
      haptics.tap();
      if (move === 'focus' && targetOpenCodeId) navigateToSession(targetOpenCodeId);
      // Still connecting: the thread opens on the target when it connects.
      if (move === 'queue' && targetOpenCodeId) {
        pendingThreadFocusRef.current = { sessionId: ps.session_id, openCodeId: targetOpenCodeId };
      }
    },
    [handleOpenProjectSession, navigateToSession]
  );
  const openSessionFromDrawer = useCallback(
    (ps: ProjectSession) => openThreadFromDrawer(ps, ps.opencode_session_id ?? null),
    [openThreadFromDrawer]
  );
  const openSubsessionFromDrawer = useCallback(
    (ps: ProjectSession, childId: string) => openThreadFromDrawer(ps, childId),
    [openThreadFromDrawer]
  );

  // The left drawer. It mounts through renderDrawerContent, so it stays mounted while visually closed.
  // The drawer's gear button is gone (COR-123/COR-160 Task 4): the project
  // Settings page is reached from Settings (drawer avatar) → project row.
  const renderDrawer = useCallback(
    () => (
      <ProjectLeftDrawer
        projectId={projectId}
        activeProjectSessionId={shownSessionId}
        activeOpenCodeSessionId={shownOpenCodeId}
        activeParentSessionId={activeProjectSession ? sessionParentId(activeProjectSession) : null}
        reviewNeedsYouCount={reviewNeedsYouCount}
        needsYouBySession={needsYouSessions}
        // New session opens project home: its composer starts the session.
        onNewSession={returnHome}
        onOpenProjectSession={openSessionFromDrawer}
        onOpenSubsession={openSubsessionFromDrawer}
        onNavigateRoute={navigateProjectRoute}
        onSessionActions={openSessionActions}
        onOpenSwitcher={openSwitcher}
        onClose={closeDrawer}
        open={drawerOpen}
      />
    ),
    [
      projectId,
      shownSessionId,
      shownOpenCodeId,
      drawerOpen,
      reviewNeedsYouCount,
      returnHome,
      openSessionFromDrawer,
      openSubsessionFromDrawer,
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
    (!activePageId && !activeSessionId && !connectingProjectSessionId);
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

  // While the computer wakes, the connecting view shows the session's saved
  // copy (lib/session/saved-copy.ts): the one this device kept, then the
  // server's, painted into the sync store under the session's OpenCode root.
  // `SessionPage` then opens on the same messages and its first runtime read
  // settles them. Only while the connecting view is on screen. A sub-agent's
  // thread reads its own saved window (`child`).
  const showingConnecting = !activePageId && ((!!activeSessionId && !threadReady) || !!connectingProjectSessionId);
  const savedCopyTarget = !showingConnecting
    ? null
    : connectingProjectSessionId
      ? { sessionId: connectingProjectSessionId, rootId: connectingRow?.opencode_session_id ?? null, child: false }
      : activeProjectSession && activeSessionId
        ? { sessionId: activeProjectSession.session_id, rootId: activeSessionId, child: !!activeSubsession }
        : null;
  const savedCopySessionId = savedCopyTarget?.sessionId ?? null;
  const savedCopyRootId = savedCopyTarget?.rootId ?? null;
  const savedCopyChild = savedCopyTarget?.child ?? false;
  // The root a saved copy proved empty (`SavedCopyOutcome.empty`): the view
  // opens on its composer instead of a loader.
  const [emptyProvenFor, setEmptyProvenFor] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId || !savedCopySessionId || !savedCopyRootId) return;
    let current = true;
    void loadSavedCopy({
      projectId,
      sessionId: savedCopySessionId,
      rootId: savedCopyRootId,
      child: savedCopyChild,
    }).then((outcome) => {
      if (current && outcome.empty) setEmptyProvenFor(savedCopyRootId);
    });
    return () => {
      current = false;
    };
  }, [projectId, savedCopySessionId, savedCopyRootId, savedCopyChild]);
  const savedCopyMessages = useSyncStore((state) =>
    savedCopyRootId ? state.messages[savedCopyRootId] : undefined
  );
  const connectingEmpty = !!savedCopyRootId && emptyProvenFor === savedCopyRootId && !connectingFirstPrompt;
  // A message typed while the computer wakes queues through the prompt inbox
  // (lib/session/connecting-send.ts), as the web does: never to a sub-agent,
  // never over a failure, and only where the thread is on screen.
  const canQueueWhileWaking =
    !!projectId &&
    !!savedCopySessionId &&
    !!savedCopyRootId &&
    !savedCopyChild &&
    !connectError &&
    (connectingEmpty || (savedCopyMessages?.length ?? 0) > 0);
  const handleWakingSend = useCallback(
    (text: string) => {
      if (!projectId || !savedCopySessionId || !savedCopyRootId) return;
      void queuePromptWhileWaking({
        projectId,
        projectSessionId: savedCopySessionId,
        rootId: savedCopyRootId,
        text,
        randomUUID: Crypto.randomUUID,
      });
    },
    [projectId, savedCopySessionId, savedCopyRootId]
  );

  // The open page, thread, or connecting session: the view route's content.
  const viewContent = isHome ? null : (
        <View className="flex-1 bg-background">
          {activePageId ? (
          /* Tool page — the SAME page component the legacy screen renders. Its
             PageHeader hamburger opens the drawer. A page that takes `onBack`
             gets handlePageBack: back to the thread it was opened over, else
             project home. Entry points: Review (drawer), Browser (a preview
             card or tool link), a project (a project_select/create tool row).
             Memory has no entry point (COR-156: re-add one or delete it). */
          activePageId === 'page:review' && PAGE_TABS[activePageId] ? (
            <Pages.ReviewPage
              page={PAGE_TABS[activePageId]}
              projectId={projectId}
              {...pageChrome}
              onOpenSession={handleOpenSessionById}
            />
          ) : activePageId === 'page:browser' && PAGE_TABS[activePageId] ? (
            <Pages.BrowserPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId === 'page:memory' && PAGE_TABS[activePageId] ? (
            <Pages.MemoryPage page={PAGE_TABS[activePageId]} onBack={handlePageBack} {...pageChrome} />
          ) : activePageId.startsWith('page:project:') ? (
            <Pages.ProjectDetailPage
              projectId={activePageId.replace('page:project:', '')}
              onBack={handlePageBack}
              {...pageChrome}
            />
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
            projectSessionId={
              activeProjectSession?.session_id ?? openedProjectSessionIdsRef.current[activeSessionId]
            }
            onBack={handleBack}
            onOpenDrawer={openDrawer}
            onOpenRightDrawer={
              activeProjectSession ? () => openSessionActions(activeProjectSession) : undefined
            }
            onRenamePress={
              activeProjectSession && !activeSubsession
                ? () => openSessionActions(activeProjectSession, 'rename')
                : undefined
            }
            sessionTitle={
              activeSubsession
                ? subsessionTitle(activeSubsession)
                : activeProjectSession
                  ? sessionDisplayTitle(activeProjectSession)
                  : undefined
            }
            subAgentRelation={activeSubAgentRelation}
            subAgents={activeSubAgents}
            onOpenProjectSession={handleOpenProjectSession}
            onCreateAgent={handleCreateAgent}
            // The row's agent binds the root thread only; a sub-session runs its own.
            // `'default'` is the server's spelling of "no agent bound" (web's session page).
            boundAgentName={
              !activeSubsession && activeProjectSession?.agent_name !== 'default'
                ? activeProjectSession?.agent_name
                : null
            }
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
              // The thread's header gradient (`SessionPage` passes `fade` too).
              fade
              title={<SessionThreadTitle title={connectingTitle} />}
            />
            <SessionConnecting
              firstMessage={connectingFirstPrompt?.text}
              firstFiles={connectingFirstPrompt?.files}
              error={connectError}
              onCancel={handleCancelConnect}
              onRestart={handleRestartSession}
              restarting={restartingSession}
              showLoader={!drawerOpen}
              messages={savedCopyMessages}
              statusLabel={
                canQueueWhileWaking ? SESSION_NOTICE.waking : (sessionConnectionLabel('waking')?.label ?? null)
              }
              sessionId={savedCopyRootId ?? undefined}
              empty={connectingEmpty}
              onSend={canQueueWhileWaking ? handleWakingSend : undefined}
              projectId={projectId}
              projectSessionId={
                activeProjectSession?.session_id ??
                connectingProjectSessionId ??
                (activeSessionId ? openedProjectSessionIdsRef.current[activeSessionId] : undefined) ??
                undefined
              }
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
        case 'page:members':
          return <Pages.MembersNavPage page={page} projectId={projectId} onBack={onBack} />;
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
        // A tap opens on the iOS sheet curve (420ms, 90% by ~154ms) and closes
        // on ease-out-quad (320ms, 80% by ~170ms); a swipe release keeps a
        // critically damped spring and its
        // velocity (`lib/ui/drawer-springs.ts`). The props come from
        // `patches/react-native-drawer-layout+4.2.10.patch`; without the patch
        // applied (`npx patch-package`), `tsc` fails on them. Module-level
        // constants: the library lists them as `useCallback` dependencies, and
        // a new object would re-toggle the drawer.
        openSpringConfig={DRAWER_OPEN}
        closeSpringConfig={DRAWER_CLOSE}
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

      {/* One session actions sheet (COR-140 Task 5): the thread's "···", the
          Sessions page's long press, and the drawer's session row long press
          all open it through `openSessionActions` (ProjectRouteValue). */}
      <SessionActionsSheet ref={actionsSheetRef} projectId={projectId} />

      {/* The project/account switcher (COR-124), opened by the drawer's
          switcher row. A picked project closes the drawer too. */}
      <ProjectSwitcherSheet
        open={switcherOpen}
        accounts={accountsQuery.data ?? []}
        selectedAccountId={project?.account_id ?? null}
        currentProjectId={projectId}
        onClose={closeSwitcher}
        onProjectOpen={closeDrawer}
        openProjectRoute={replaceProject}
      />
    </>
  );
}
