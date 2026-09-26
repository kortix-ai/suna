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
import { requestPushPermissionOnce } from '@/lib/notifications/registration';
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
  drawerThreadMove,
  threadOpenTarget,
  type PendingThreadFocus,
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
import { ProjectHome, type ProjectHomeSubmit } from '@/components/session/ProjectHome';
import type { AttachedFile } from '@/lib/session/attachments';
import { newSessionCreateInput } from '@/lib/session/new-session-input';
import {
  projectSessionForOpenCodeId,
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
import { needsYouBySession } from '@/lib/session/needs-you';
import { countReviewItemsBySegment, getProjectSession } from '@kortix/sdk';
import * as Crypto from 'expo-crypto';
import {
  deleteProjectSession,
  startProjectSession,
  restartProjectSession,
} from '@/lib/projects/projects-client';
import type {
  ProjectSession,
  SessionStartResult,
} from '@/lib/projects/projects-client';
import {
  connectStepFromRequestError,
  connectStepFromStart,
  shouldAwaitHealthProbe,
  startPollDelayMs,
} from '@/lib/session/connect-step';
import { createSessionCommitted } from '@/lib/session/create-session';
import { firstPromptSeed, SEED_BUSY_WATCHDOG_MS, seedUndelivered } from '@/lib/session/first-prompt-seed';
import { useSyncStore } from '@/lib/opencode/sync-store';
import { useToast } from '@/components/kortix/toast-provider';
import { getUpgradeGate } from '@/lib/billing/upgrade-gate';
import { useUpgradeSheetStore } from '@/stores/upgrade-sheet-store';
import { clearComposerDraftIfSent } from '@/stores/composer-draft-store';
import { draftKey } from '@/lib/session/composer-draft';
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
  const navigateToSession = useTabStore((s) => s.navigateToSession);

  // Data
  // Repo-first project sessions (web model): GET /projects/:id/sessions.
  const { data: projectSessions = [] } = useProjectSessions(projectId, { poll: isFocused });
  // A project session that's provisioning — the middle pane shows a connecting
  // state and the project-sessions poll opens it once its sandbox is ready.
  const [connectingProjectSessionId, setConnectingProjectSessionId] = useState<string | null>(null);
  // The same id, current for callbacks that closed over an older render
  // (`goHome` runs from navigation listeners).
  const connectingIdRef = useRef<string | null>(null);
  connectingIdRef.current = connectingProjectSessionId;
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
  // The typed text and picked files of a fresh dashboard send, keyed by the
  // session id it created — shown as the loading page's first message and
  // file tiles (the text is also its title until the session has one) and,
  // read-and-cleared once, restored into the composer if the user leaves a
  // failed start ("Back to project", `ProjectHome`'s `takeInitialDraft`).
  // Cleared once the session connects.
  const firstPromptRef = useRef<Record<string, { text: string; files: AttachedFile[] }>>({});
  const pendingDraftRef = useRef<{ text: string; files: AttachedFile[] }>({ text: '', files: [] });
  const takeInitialDraft = useCallback(() => {
    const draft = pendingDraftRef.current;
    pendingDraftRef.current = { text: '', files: [] };
    return draft;
  }, []);
  const createProjectSession = useCreateProjectSession(projectId);
  const openUpgradeSheet = useUpgradeSheetStore((state) => state.openUpgradeSheet);

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

  // The busy watchdog of each seeded root (COR-185), keyed by OpenCode id.
  const seedWatchdogsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    const watchdogs = seedWatchdogsRef.current;
    return () => {
      for (const timer of Object.values(watchdogs)) clearTimeout(timer);
    };
  }, []);

  // Write a dashboard send's first prompt into the sync store as an optimistic
  // user message, plus a busy status, BEFORE the thread mounts (COR-185).
  // SessionPage then opens with the prompt and the busy row on its first
  // frame, instead of the empty hero until the echo lands. The echo replaces
  // the seed through the ordinary optimistic swap. Always under the OpenCode
  // root, never the Kortix session id. The server holds this prompt, so the
  // seed never offers "Try again" (a client re-send would run it twice): the
  // watchdog only clears a busy row that saw no sign of the prompt in 30 s,
  // and the seed stays optimistic so a late echo still replaces it.
  const seedFirstPrompt = useCallback(
    (root: string, first: { text: string; files: AttachedFile[] } | undefined) => {
      if (!first) return;
      const store = useSyncStore.getState();
      const seed = firstPromptSeed({
        ...first,
        opencodeSessionId: root,
        knownMessageIds: (store.messages[root] ?? []).map((m) => m.info.id),
        nowMs: Date.now(),
      });
      if (!seed) return;
      store.addOptimisticMessage(root, seed);
      store.setStatus(root, { type: 'busy' });
      clearTimeout(seedWatchdogsRef.current[root]);
      seedWatchdogsRef.current[root] = setTimeout(() => {
        delete seedWatchdogsRef.current[root];
        const now = useSyncStore.getState();
        if (seedUndelivered(now.messages[root], seed.info.id) && now.sessionStatus[root]?.type === 'busy') {
          log.warn(`⏱️ [connect] first prompt not seen in ${SEED_BUSY_WATCHDOG_MS} ms; clearing busy`);
          now.setStatus(root, { type: 'idle' });
        }
      }, SEED_BUSY_WATCHDOG_MS);
    },
    []
  );

  // The Kortix `session_id` of each thread this screen opened, keyed by its
  // OpenCode root id. The thread's `projectSessionId` falls back to it while
  // the sessions list has not caught up with a just-created session, so a
  // new thread takes photos from its first frame (COR-185).
  const openedProjectSessionIdsRef = useRef<Record<string, string>>({});
  // A sub-session to show once its project session's thread connects: a
  // sub-session row tapped while its parent was not open (or still
  // connecting). `connectToProjectSession` opens the thread on it instead of
  // the root, then clears it. Any other open replaces or clears it.
  const pendingThreadFocusRef = useRef<PendingThreadFocus | null>(null);

  // Refetch both session lists (the drawer's and the paged Sessions page).
  const refreshSessionLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) });
    void queryClient.invalidateQueries({ queryKey: projectKeys.projectSessionsPaged(projectId) });
  }, [queryClient, projectId]);

  // Switch the SandboxContext to a session's sandbox and render its chat. Needs
  // both the sandbox URL and the resolved OpenCode pin (opencode_session_id).
  const connectToProjectSession = useCallback(
    (ps: ProjectSession) => {
      if (!ps.sandbox_url || !ps.opencode_session_id) return false;
      const externalId =
        ps.sandbox_url.match(/\/p\/([^/]+)\//)?.[1] || ps.sandbox_id || ps.session_id;
      // The root, or a pending sub-session of this session. The sandbox gate
      // (openedThreadRef) records the id the store is about to show.
      const threadId = threadOpenTarget(pendingThreadFocusRef.current, ps.session_id, ps.opencode_session_id);
      pendingThreadFocusRef.current = null;
      // The same value switchSandbox derives from `external_id`.
      openedThreadRef.current = {
        sessionId: threadId,
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
      seedFirstPrompt(ps.opencode_session_id, firstPromptRef.current[ps.session_id]);
      delete firstPromptRef.current[ps.session_id];
      openedProjectSessionIdsRef.current[ps.opencode_session_id] = ps.session_id;
      openedProjectSessionIdsRef.current[threadId] = ps.session_id;
      navigateToSession(threadId);
      // The row may be missing from the lists yet (a just-created session):
      // refetch them, so the thread's title and `···` menu appear.
      refreshSessionLists();
      return true;
    },
    [switchSandbox, navigateToSession, seedFirstPrompt, refreshSessionLists]
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
            const openSession = (opencodeSessionId: string) =>
              connectToProjectSession({
                session_id: sessionId,
                sandbox_id: sandbox.sandbox_id,
                sandbox_url: sandboxUrl,
                opencode_session_id: opencodeSessionId,
                sandbox_provider: sandbox.provider ?? 'daytona',
                created_at: sandbox.created_at,
                updated_at: sandbox.updated_at,
              } as ProjectSession);

            // `/start` already reports the runtime ready with its pin: open
            // the thread now (COR-185). The probe still runs, unawaited, as
            // it keeps the proxy route warm.
            if (!shouldAwaitHealthProbe(start) && start.opencode_session_id) {
              log.log(`💓 [connect] attempt ${attempt}: stage=ready pin=ok, opening without the health wait`);
              openSession(start.opencode_session_id);
              void probeSandboxHealth(sandboxUrl);
              return;
            }

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
              openSession(start.opencode_session_id);
              return;
            }
          } else {
            log.log(`💓 [connect] attempt ${attempt}: stage=${start.stage}`);
          }

          // Not ready yet: 300 ms, 700 ms, then 1.5 s between polls.
          await new Promise((r) => setTimeout(r, startPollDelayMs(attempt)));
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
  // `focusOpenCodeId` (a sub-session row): the thread opens on that
  // sub-session instead of the root once it connects.
  const handleOpenProjectSession = useCallback(
    (ps: ProjectSession, focusOpenCodeId?: string) => {
      pendingThreadFocusRef.current = focusOpenCodeId
        ? { sessionId: ps.session_id, openCodeId: focusOpenCodeId }
        : null;
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
      pendingThreadFocusRef.current = null;
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

  // The active tab's project-session row. The tab store's activeSessionId is an
  // OPENCODE id — the root (connectToProjectSession navigates with
  // ps.opencode_session_id), or a sub-session of it (a drawer sub-session row,
  // a task tool's View) — so resolve back to the Kortix row through the pin or
  // the row's `opencode_sessions` snapshot. Every
  // /projects/:id/sessions/:sid API call needs the Kortix UUID.
  const activeProjectSession = useMemo(
    () => projectSessionForOpenCodeId(projectSessions, activeSessionId),
    [projectSessions, activeSessionId]
  );
  // The thread shows a sub-session of that row, not its root: the header
  // reads the sub-session's title and the title tap (rename of the project
  // session) is off.
  const activeSubsession = useMemo(
    () =>
      activeProjectSession && activeSessionId && activeSessionId !== activeProjectSession.opencode_session_id
        ? ((activeProjectSession.opencode_sessions ?? []).find((item) => item.id === activeSessionId) ?? null)
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

  // The loading page's header title and first message, so it reads as the
  // thread it becomes: the session's own title once it has one, else the
  // just-sent prompt, else "New session".
  const connectingRow = connectingProjectSessionId
    ? (projectSessions.find((s) => s.session_id === connectingProjectSessionId) ?? null)
    : activeProjectSession;
  const connectingFirstPrompt = connectingProjectSessionId
    ? firstPromptRef.current[connectingProjectSessionId]
    : undefined;
  const connectingTitle =
    (connectingRow ? resolveSessionTitle(connectingRow) : null) ??
    (connectingFirstPrompt?.text || null) ??
    'New session';

  // Drive the connecting state. ensureAndOpen polls /start and opens the chat.
  // It guards against concurrent runs, so re-firing on re-render is harmless. A
  // session that ended in an error is skipped so we don't immediately re-loop it;
  // recovery is the explicit Restart button.
  useEffect(() => {
    if (!connectingProjectSessionId) return;
    if (erroredSessionRef.current === connectingProjectSessionId) return;
    void ensureAndOpen(connectingProjectSessionId);
  }, [connectingProjectSessionId, ensureAndOpen]);

  // No thread or page is on screen: the thread closed (deleted or
  // archived), another session is connecting, or
  // this project just opened on project home (setScope). Leave the previous
  // session's sandbox, so the live stream never stays on it while the next
  // session connects or after its connect fails. A page opened from a thread
  // keeps the sandbox, as the page reads it (lib/session/session-sandbox).
  const showsSessionContent = showsSessionContentFor({
    activeSessionId,
    activePageId,
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
    // A connecting session's first prompt belongs to that attempt only:
    // reopening the session later must not show it again with a busy row.
    // `handleCancelConnect` reads the entry before it calls this.
    const connectingId = connectingIdRef.current;
    if (connectingId) delete firstPromptRef.current[connectingId];
    isHomeRef.current = true;
    returnThreadRef.current = null;
    ensuringRef.current = null;
    openedThreadRef.current = null;
    setConnectingProjectSessionId(null);
    setConnectError(null);
    clearSandbox();
    const tabs = useTabStore.getState();
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
  // project session with the first prompt and drops into the connecting
  // state — the effect provisions and opens it once ready. Resolves `true`
  // once the session exists, `false` on any failure (ProjectHome then keeps
  // the draft and hands its uploads back to the composer).
  const [isDashboardSending, setIsDashboardSending] = useState(false);

  const handleDashboardSend = useCallback(
    async ({ text, files, fileParts, model, picks, agent }: ProjectHomeSubmit): Promise<boolean> => {
      if (!projectId || isDashboardSending) return false;
      if (!text.trim() && files.length === 0) return false;

      setIsDashboardSending(true);
      try {
        // Files are already uploaded (ProjectHome's `useComposerAttachments`)
        // and ride the create as `pending_prompt.parts`, which the server
        // delivers once the runtime is up. The model is baked in at create.
        // A thinking level cannot ride `initial_prompt` (it carries text only),
        // so a send with a level uses `pending_prompt` too
        // (`lib/session/new-session-input.ts`).
        const hasFiles = files.length > 0;
        // Warm path (web parity, `lib/session/warm-session.ts`): the project
        // keeps one session booted while this screen is open. A send on the
        // project defaults claims it with its first prompt, so the sandbox
        // boot is already done. A send with files never fits it
        // (`warmFitsSend`). Anything it does not fit, or a refused claim,
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
        }
        // Ordinary create (web parity, COR-185): the client mints the id, so a
        // timed-out create that committed is read back and used instead of
        // letting a re-send create a second session. Created FIRST, then the
        // connecting state below: a failed create never shows a live-looking
        // session. The composer's send slot shows the spinner meanwhile.
        const createNew = async (): Promise<string> => {
          const sessionId = Crypto.randomUUID();
          const input = newSessionCreateInput({
            sessionId,
            text,
            fileParts,
            fileNames: files.map((f) => f.name),
            model,
            picks,
            agent,
          });
          return createSessionCommitted(
            {
              create: (body) => createProjectSession.mutateAsync(body),
              read: (id) => getProjectSession(projectId, id, { showErrors: false }),
            },
            { ...input, session_id: sessionId },
          );
        };
        const session = { session_id: claimedWarm ?? (await createNew()) };
        // The lists learn of the new session now, not at their next poll —
        // also after a timed-out create that committed (`createSessionCommitted`).
        refreshSessionLists();
        // The loading page's first message and file tiles, and "Back to
        // project"'s draft restore, all key off this. An image-only send
        // sets it too, so the loading page shows the photo.
        if (text.trim() || hasFiles) {
          firstPromptRef.current[session.session_id] = { text: text.trim(), files };
        }
        // Enter the connecting state — the effect drives provisioning and opens
        // the server-created session once ready.
        navigateToSession(null);
        setConnectError(null);
        erroredSessionRef.current = null;
        freshSessionIdRef.current = session.session_id;
        setConnectingProjectSessionId(session.session_id);
        // The session holds the prompt now: drop the home's saved draft
        // (COR-143). Cancel hands the text back through `takeInitialDraft`.
        clearComposerDraftIfSent(draftKey({ kind: 'project', projectId }), text);
        // The first send asks for notification permission, once per install.
        void requestPushPermissionOnce();
        return true;
      } catch (err: any) {
        if (showUpgradeForError(err)) return false;
        log.error('❌ [Project] Home send failed:', err?.message || err);
        toast.error(err?.message || 'Failed to start session');
        return false;
      } finally {
        setIsDashboardSending(false);
      }
    },
    [projectId, isDashboardSending, createProjectSession, navigateToSession, showUpgradeForError, toast, refreshSessionLists]
  );

  // The model sheet's Agent tab `+` (thread and home alike): a new session on
  // the shared "configure a new agent" prompt, web's Agents page "New". Same
  // create + connecting path as a project-home send.
  const handleCreateAgent = useCallback(() => {
    void handleDashboardSend({
      text: newConfigPrompt('agent'),
      files: [],
      fileParts: [],
      model: null,
      picks: null,
      agent: null,
    });
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

  // Leave a connecting session (COR-146). `SessionConnecting` offers this only
  // in its error state, as "Back to project" (Jay, 2026-09-24: no Cancel bar
  // while it loads); Android back and the drawer leave through `goHome`.
  // Stops the client-side connect loop and returns home immediately — never
  // blocked on the network call below. A session THIS screen just created
  // (freshSessionIdRef) is DELETED server-side (the same call as the actions
  // sheet's Delete), so no stopped session keeps the cancelled prompt and a
  // re-send of the restored draft cannot run it twice. A session reopened
  // from the list is never deleted or stopped: it may hold real history the
  // user still wants. If the text and files that started this attempt are
  // still known (a dashboard send), they are restored into the project-home
  // composer (`ProjectHome`'s `takeInitialDraft`, consumed once); the
  // restored files upload again there, as the deleted session held the old
  // uploads.
  const handleCancelConnect = useCallback(() => {
    const sid = connectingProjectSessionId;
    haptics.tap();
    const restore = sid ? firstPromptRef.current[sid] : undefined;
    const wasFresh = sid !== null && freshSessionIdRef.current === sid;
    if (sid) delete firstPromptRef.current[sid];
    freshSessionIdRef.current = null;
    if (restore && (restore.text || restore.files.length > 0)) {
      pendingDraftRef.current = { text: restore.text, files: restore.files };
      setHomeKey((key) => key + 1);
    }
    goHome();
    if (wasFresh && sid) {
      // One retry after 2 s: a dropped request must not leave an orphan
      // session holding the cancelled prompt.
      deleteProjectSession(projectId, sid)
        .catch(() => new Promise((resolve) => setTimeout(resolve, 2_000)).then(() => deleteProjectSession(projectId, sid)))
        .catch((err) => {
          log.warn('⚠️ [connect] Cancel: could not delete the just-created session:', err?.message || err);
        })
        .finally(refreshSessionLists);
    }
  }, [connectingProjectSessionId, goHome, projectId, refreshSessionLists]);

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

  // The switcher's pick of another project: replace this whole project in the
  // root stack, so ProjectScreen remounts on the new `id`.
  // `router.replace(projectHref(id))` cannot do it from here: expo-router
  // treats `projects/[id]` → `projects/[id]` as the same route whatever the
  // `id`, and dispatches into the project stack (ProjectSwitcherSheet,
  // `openProjectRoute`).
  const replaceProject = useCallback(
    (nextProjectId: string) => {
      navigation.dispatch(StackActions.replace('projects/[id]', { id: nextProjectId }));
    },
    [navigation]
  );

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
              firstMessage={connectingFirstPrompt?.text}
              firstFiles={connectingFirstPrompt?.files}
              error={connectError}
              onCancel={handleCancelConnect}
              onRestart={handleRestartSession}
              restarting={restartingSession}
              showLoader={!drawerOpen}
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
        openProjectRoute={replaceProject}
      />
    </>
  );
}
