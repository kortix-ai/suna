import { useEffect, useRef, useState } from 'react';
import { useClearFocusedToolCall, useFocusedToolCallId, useKortixComputerStore } from '../../../internal/stores/kortix-computer-store';
import { useSessionBrowserStore } from '../../../internal/stores/session-browser-store';
import { pathOutput, shouldAutoExpandOutputs, shouldAutoOpenPayoff, stepForCallId } from '../easy/easy-panel-logic';
import { StepDetailBody } from '../easy/step-detail-body';
import { StepIcon } from '../easy/step-icon';
import { selectPrimaryDeliverable } from './output-priority';
import type { SessionPanelValue } from '../session-panel-provider';
import type { usePanelDerivations } from './use-panel-derivations';

type Handoffs = Pick<SessionPanelValue,
  'sessionId' | 'projectId' | 'projectSessionId' | 'detail' | 'handleOpenOutput' |
  'openDetail' | 'openTerminal' | 'openAudit' | 'openBrowser' | 'openFiles'
> & Pick<ReturnType<typeof usePanelDerivations>, 'isRunning' | 'outcome' | 'apps' | 'files' | 'steps'>;

export function usePanelHandoffs({
  sessionId, projectId, projectSessionId, isRunning, outcome, apps, files, steps,
  detail, handleOpenOutput, openDetail, openTerminal, openAudit, openBrowser, openFiles,
}: Handoffs) {
  // Auto-expand Outputs the moment a run finishes with something to show —
  // never on every render of an already-finished (or still-running) run, and
  // never on a failed one: a pile of half-written files is not a celebration.
  const wasRunningRef = useRef(isRunning);
  const [outputsDefaultOpen, setOutputsDefaultOpen] = useState(false);
  useEffect(() => {
    if (
      outcome === 'succeeded' &&
      shouldAutoExpandOutputs(wasRunningRef.current, isRunning, files.length)
    ) {
      setOutputsDefaultOpen(true);
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, files.length, outcome]);

  // Payoff (W2): present the primary deliverable exactly once, at the finish,
  // and only when the user hasn't taken the wheel themselves this run.
  //
  // No longer gated on the panel already being open (Jay's call): the detail
  // panel is content-driven now, so the payoff opening it IS the presentation.
  // Replay is still impossible — the predicate fires only on the running→idle
  // EDGE, only on success, only with no detail already up, and only when the
  // user hasn't opened something themselves this run.
  const interactedThisRunRef = useRef(false);
  useEffect(() => {
    if (detail !== null) interactedThisRunRef.current = true;
  }, [detail]);
  const prevRunningRef = useRef(isRunning);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    if (!wasRunning && isRunning) interactedThisRunRef.current = false;
    prevRunningRef.current = isRunning;
    // Fresh-only (unlike the chip-consume effect below): the payoff is this
    // run's reward for THIS run's work. Without this filter,
    // selectPrimaryDeliverable's stale fallback fires on every text-only turn
    // in a session with history, auto-opening a deliverable from a run the
    // user already saw.
    const freshApps = apps.filter((a) => a.fresh);
    const freshFiles = files.filter((f) => f.fresh);
    const primary = selectPrimaryDeliverable(freshApps, freshFiles);
    if (
      shouldAutoOpenPayoff({
        wasRunning,
        isRunning,
        outcome,
        hasPrimary: primary !== null,
        detailOpen: detail !== null,
        interactedThisRun: interactedThisRunRef.current,
      }) &&
      primary
    ) {
      // The primary came from whichever list `selectPrimaryDeliverable`
      // actually picked it from — nav must page through that same list.
      handleOpenOutput(primary, primary.kind === 'app' ? apps : files, 'auto');
    }
  }, [isRunning, outcome, detail, apps, files, handleOpenOutput]);

  // Chip tap (W1→W2 handoff): the header asked us to open the primary
  // deliverable. Subscribe to the pending-request VALUE, not the (stable)
  // consume action — see this file's header note 1. `consumePrimaryOpen` keeps
  // it one-shot.
  const pendingPrimaryOpenSessionId = useKortixComputerStore((s) => s.pendingPrimaryOpenSessionId);
  useEffect(() => {
    if (pendingPrimaryOpenSessionId !== sessionId) return;
    if (!useKortixComputerStore.getState().consumePrimaryOpen(sessionId)) return;
    // Unfiltered (unlike the payoff effect above): the chip was already
    // earned by a real finish, possibly in an earlier render than this one —
    // the stale fallback is this path's legitimate purpose, so a user who
    // taps a chip after navigating away still lands on something.
    const primary = selectPrimaryDeliverable(apps, files);
    if (primary) handleOpenOutput(primary, primary.kind === 'app' ? apps : files, 'chip');
  }, [pendingPrimaryOpenSessionId, sessionId, apps, files, handleOpenOutput]);

  // A file path clicked in the chat, or in a read/write/edit tool card, lands
  // here. Same one-shot handoff shape as the chip- and quick-view-consume
  // effects, and for the same reason (header note 1).
  //
  // The nonce, not the path, is the guard: clicking the same file twice must
  // re-open it, and `requestFileOpenSilently` bumps the nonce on every call.
  // A ref rather than state — consuming must not itself schedule a render.
  const fileOpenRequest = useSessionBrowserStore((s) => s.fileOpenBySession[sessionId]);
  const lastFileOpenNonce = useRef(0);
  useEffect(() => {
    if (!fileOpenRequest || fileOpenRequest.nonce === lastFileOpenNonce.current) return;
    lastFileOpenNonce.current = fileOpenRequest.nonce;
    // No siblings: a path clicked in prose belongs to no list, so there is
    // nothing for prev/next to page through and the detail earns no nav row.
    handleOpenOutput(pathOutput(fileOpenRequest.path), undefined, 'row');
  }, [fileOpenRequest, handleOpenOutput]);

  const pendingQuickView = useKortixComputerStore((s) => s.pendingQuickView);

  /**
   * A tool call clicked in the CHAT opens that tool's real view in the panel.
   *
   * This is the last escape hatch to the raw truth in Easy mode, and it costs
   * nothing: the affordance lives in the chat, so there is no new thing to
   * click here and no new way to get lost. The user asked to see one specific
   * thing; they see that thing.
   *
   * `panel_opened` is tracked in `session-chat.tsx`'s `handleToolActivate`,
   * NOT here (MINOR SWEEP c): by the time this effect runs, the store's
   * `focusToolCall` action has already flipped `isSidePanelOpen` to true, so
   * a "was it already open?" read at this point would always answer "yes"
   * and the event would never fire honestly. `handleToolActivate` is the
   * only point in the flow where the pre-open state is still observable.
   */
  const focusedToolCallId = useFocusedToolCallId();
  const clearFocusedToolCall = useClearFocusedToolCall();
  useEffect(() => {
    if (!focusedToolCallId) return;
    const step = stepForCallId(steps, focusedToolCallId);
    if (step) {
      openDetail({
        // The call id is part of the key on purpose: a step is a GROUP, and
        // two clicks on different commands inside it produce the same
        // `step:<id>`. Deduped on that key, the second click was a no-op and
        // the panel kept showing whatever it showed before.
        key: `step:${step.id}:${focusedToolCallId}`,
        title: step.label,
        icon: <StepIcon family={step.family} status={step.status} />,
        padded: false,
        body: (
          <StepDetailBody
            calls={step.parts}
            sessionId={sessionId}
            focusCallId={focusedToolCallId}
          />
        ),
      });
    }
    clearFocusedToolCall();
  }, [focusedToolCallId, steps, clearFocusedToolCall, sessionId, openDetail]);

  // Command palette / header "Open Terminal"/"Open Audit"/"Open Browser"/
  // "Open Files" (W1→W2-shaped handoff): subscribe to the pending request
  // VALUE, not the stable `consumeQuickView` action — see header note 1.
  // Audit with no project context (booting/transient session) is a
  // deliberate no-op: there's nothing to drill into yet.
  useEffect(() => {
    if (pendingQuickView?.sessionId !== sessionId) return;
    const request = useKortixComputerStore.getState().consumeQuickView(sessionId);
    if (!request) return;
    const { view, target } = request;
    if (view === 'terminal') {
      openTerminal();
    } else if (view === 'audit' && projectId && projectSessionId) {
      openAudit();
    } else if (view === 'browser') {
      openBrowser(target);
    } else if (view === 'files') {
      openFiles(target?.changes);
    }
  }, [
    pendingQuickView,
    sessionId,
    projectId,
    projectSessionId,
    openTerminal,
    openAudit,
    openBrowser,
    openFiles,
  ]);

  return { outputsDefaultOpen, pendingQuickView };
}
