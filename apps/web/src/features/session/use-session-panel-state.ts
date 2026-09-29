'use client';

import { useDeliverableReadiness } from '@/features/session/action-panel/shared/use-deliverable-readiness';
import { isPendingAction, useSessionAudit } from '@/features/session/session-audit-shared';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import {
  normalizeSessionPanelLayoutView,
  SessionPanelView,
  useSessionBrowserStore,
} from '@/stores/session-browser-store';
import { useTabStore } from '@/stores/tab-store';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { useRuntimeMessages, useSessionStateStore, useSessionWorking } from '@kortix/sdk/react';
import { useEffect } from 'react';

function useSessionPanelView({
  sessionId,
  projectId,
  projectSessionId,
  transient,
  booting,
}: {
  sessionId: string;
  projectId?: string;
  projectSessionId?: string;
  transient: boolean;
  booting: boolean;
}) {
  // Tool parts and message info only: the action panel and the deliverable
  // detector never read streamed text, so a text delta must not re-render the
  // layout (and every panel consumer under its provider) once per ~16 ms batch.
  const { data: messages } = useRuntimeMessages(sessionId, { ignoreStreamedText: true });

  const storedPanelView = useSessionBrowserStore((s) => s.viewBySession[sessionId]);
  const panelView = normalizeSessionPanelLayoutView(storedPanelView);

  // Existing users' persisted preferences predate this key.
  const panelMode = useUserPreferencesStore((s) => s.preferences.panelMode ?? 'easy');
  const togglePanelMode = useUserPreferencesStore((s) => s.togglePanelMode);
  const isEasy = panelMode === 'easy';

  // The session's own working state — literally the same projection
  // `session-chat.tsx` reads (as `isServerBusy`) to drive its own working
  // indicator, over one shared `GET .../turn` cache entry and one shared send
  // receipt. It used to be the raw SSE status slot instead, and a dropped
  // end-of-turn frame left THIS panel reporting "running" while the composer
  // beside it correctly read idle — so `useDeliverableReadiness` never saw the
  // running→settled transition and the W1 "ready" chip never fired for that run.
  //
  // A transient sub-session has no Kortix session row for `/turn` to answer
  // about, so it keeps the stream slot — repaired on every stream (re)connect
  // by the status-snapshot reconciler in `use-opencode-events`.
  const sessionStatus = useSessionStateStore((s) => s.sessionStatus[sessionId]);
  const working = useSessionWorking(projectId ?? '', projectSessionId ?? '', {
    enabled: !!projectId && !!projectSessionId,
    runtimeSessionId: sessionId,
  });
  const isSessionBusy =
    projectId && projectSessionId
      ? working.state === 'working'
      : sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';

  // W1/W9 — announce finished deliverables and blocked-on-you states while the
  // panel is closed. Headless: writes the ready chip; the header renders it.
  useDeliverableReadiness(sessionId, messages, isSessionBusy);

  // Easy mode is only ever the card home — the other views are engineer
  // surfaces reached through the (hidden) tab strip. Force the view and skip
  // their bodies entirely; `session-browser-store`'s `viewBySession` stays
  // untouched so Advanced mode picks up right where the user left it.
  const effectiveView: SessionPanelView = isEasy ? 'actions' : panelView;

  // Pending-approval count for the "Audit" tab badge. Shares the header nudge's
  // query key so this is one deduped request; skipped while booting/transient.
  const { data: auditData } = useSessionAudit(projectId, projectSessionId, {
    enabled: !transient && !booting && !!projectId && !!projectSessionId,
    silent: true,
    // A badge, not a timeline: pending approvals are recent by construction.
    limit: 100,
  });
  const auditPendingCount = (auditData?.actions ?? []).filter(isPendingAction).length;

  return { messages, isSessionBusy, isEasy, effectiveView, auditPendingCount, togglePanelMode };
}

function useSessionPanelSessionSync({
  sessionId,
  projectSessionId,
  transient,
}: {
  sessionId: string;
  projectSessionId?: string;
  transient: boolean;
}) {
  const isSidePanelOpen = useKortixComputerStore((s) => s.isSidePanelOpen);
  const setIsSidePanelOpen = useKortixComputerStore((s) => s.setIsSidePanelOpen);
  const setActiveSession = useKortixComputerStore((s) => s.setActiveSession);
  const shouldOpenPanel = useKortixComputerStore((s) => s.shouldOpenPanel);
  const clearShouldOpenPanel = useKortixComputerStore((s) => s.clearShouldOpenPanel);

  const isActiveTab = useTabStore((s) => s.activeTabId === sessionId);
  const isInTabSystem = useTabStore((s) => !!s.tabs[sessionId]);
  // "This layout is the one on screen." A session inside the tab system is
  // visible when it is the active tab; a session on the standalone
  // /projects/:id/sessions/:id route has no tab and is always the visible one.
  const isVisibleLayout = isInTabSystem ? isActiveTab : true;

  // Tell the store which session owns the right side, and close it.
  //
  // This used to be gated on `isActiveTab` alone and skipped for transient
  // sessions, so on the standalone route — and in the window before
  // `tab-store.activeTabId` catches up with a navigation — it never fired.
  // The store kept the PREVIOUS session's `isSidePanelOpen`, so opening a
  // second session rendered its panel already open with nothing to put in it:
  // the empty loading panel. Firing on visibility covers every entry path
  // (fresh navigation, tab switch, back/forward, transient → real handoff),
  // and `setActiveSession` closes both surfaces, so a session you have just
  // arrived at never inherits the last one's right side.
  //
  // `continuity` names the Kortix project session behind this layout id and
  // whether this mount is the transient boot shell. The store uses it for one
  // thing: the boot→ready crossfade renames the layout from the Kortix session
  // id (shell) to the OpenCode id (real chat) for the SAME session — that
  // handoff must carry an open panel across instead of slamming it shut.
  useEffect(() => {
    if (!isVisibleLayout) return;
    setActiveSession(sessionId, {
      projectSessionId: projectSessionId ?? null,
      transient,
    });
  }, [isVisibleLayout, sessionId, setActiveSession, projectSessionId, transient]);

  useEffect(() => {
    if (shouldOpenPanel && !isSidePanelOpen) {
      setIsSidePanelOpen(true);
      clearShouldOpenPanel();
    } else if (shouldOpenPanel) {
      clearShouldOpenPanel();
    }
  }, [shouldOpenPanel, isSidePanelOpen, setIsSidePanelOpen, clearShouldOpenPanel]);

  const setActivePanelSession = useSessionBrowserStore((s) => s.setActiveSessionId);
  useEffect(() => {
    if (transient) return;
    if (!isVisibleLayout) return;
    setActivePanelSession(sessionId);
    return () => {
      if (useSessionBrowserStore.getState().activeSessionId === sessionId) {
        setActivePanelSession(null);
      }
    };
  }, [transient, isVisibleLayout, sessionId, setActivePanelSession]);
  // ⌘I / Ctrl+I lives on `SessionActionPanelColumn` — it toggles the RIGHT SIDE
  // as a whole (`toggleRightPanel`), so it closes this detail panel too. The
  // detail panel is still content-driven: the key never opens it empty, only
  // back onto content this session already has.
}
