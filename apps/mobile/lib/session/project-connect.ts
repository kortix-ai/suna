import type React from 'react';
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { getAuthToken } from '@/api/config';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { appIsActive } from '@/hooks/useWarmProjectSession';
import { warmSessionPool } from '@/lib/session/warm-session-pool';
import { useTabStore } from '@/stores/tab-store';
import { haptics } from '@/lib/haptics';
import { log } from '@/lib/logger';
import { useQueryClient } from '@tanstack/react-query';
import { listCreatedSession, projectKeys, useCreateProjectSession } from '@/lib/projects/hooks';
import { getProjectSession } from '@kortix/sdk';
import { getUpgradeGate } from '@/lib/billing/upgrade-gate';
import { useUpgradeSheetStore } from '@/stores/upgrade-sheet-store';
import { useToast } from '@/components/kortix/toast-provider';
import { clearComposerDraftIfSent } from '@/stores/composer-draft-store';
import { draftKey } from '@/lib/session/composer-draft';
import { getSandboxUrl, type SandboxProviderName } from '@/lib/platform/client';
import { deleteProjectSession, startProjectSession, restartProjectSession, type ProjectSession, type SessionStartResult } from '@/lib/projects/projects-client';
import { connectStepFromRequestError, connectStepFromStart, shouldAwaitHealthProbe, startPollDelayMs } from '@/lib/session/connect-step';
import { createSessionCommitted } from '@/lib/session/create-session';
import { firstPromptSeed, SEED_BUSY_WATCHDOG_MS, seedUndelivered } from '@/lib/session/first-prompt-seed';
import { useSyncStore } from '@/lib/opencode/sync-store';
import { threadOpenTarget, returnThreadForPage, type PendingThreadFocus } from '@/lib/session/project-stack';
import { projectSessionForOpenCodeId, resolveSessionTitle } from '@/lib/session/session-list';
import type { OpenedThread } from '@/lib/session/session-sandbox';
import type { AttachedFile } from '@/lib/session/attachments';
import type { ProjectHomeSubmit } from '@/components/session/ProjectHome';
import type { SessionConnectError } from '@/components/session/SessionConnecting';
import { newSessionCreateInput } from '@/lib/session/new-session-input';
import { newConfigPrompt } from '@kortix/shared';
import * as Crypto from 'expo-crypto';
import { requestPushPermissionOnce } from '@/lib/notifications/registration';
import { useFocusEffect } from 'expo-router/react-navigation';
import { leaveSandboxOnFocus, showsSessionContent as showsSessionContentFor } from '@/lib/session/session-sandbox';

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

export function useProjectSessionConnect(projectId: string, projectSessions: ProjectSession[], activeSessionId: string | null, activePageId: string | null, releaseWarmSession: (id: string) => void, setHomeKey: React.Dispatch<React.SetStateAction<number>>) {
  const { switchSandbox, clearSandbox } = useSandboxContext();
  const navigateToSession = useTabStore((s) => s.navigateToSession);
  const queryClient = useQueryClient();
  const createProjectSession = useCreateProjectSession(projectId);
  const openUpgradeSheet = useUpgradeSheetStore((state) => state.openUpgradeSheet);
  const toast = useToast();
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
  const showUpgradeForError = useCallback(
    (error: unknown) => {
      const gate = getUpgradeGate(error);
      if (!gate) return false;
      openUpgradeSheet(gate);
      return true;
    },
    [openUpgradeSheet]
  );
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
            // Restart button (web parity with "Session runtime is not ready").
            if (health.bootError) {
              failConnect(sessionId, {
                title: 'Session runtime is not ready',
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
  return {
    connectingProjectSessionId, connectError, restartingSession,
    connectingRow, connectingFirstPrompt, connectingTitle, activeProjectSession,
    openedThreadRef, openedProjectSessionIdsRef, pendingThreadFocusRef, returnThreadRef,
    isHomeRef, ensuringRef, navigateToSession, goHome, refreshSessionLists,
    firstPromptRef, freshSessionIdRef, erroredSessionRef, setConnectError, setConnectingProjectSessionId, showUpgradeForError,
    handleOpenProjectSession, handleOpenSessionById, handleRestartSession,
    handleCancelConnect, takeInitialDraft,
  };
}
