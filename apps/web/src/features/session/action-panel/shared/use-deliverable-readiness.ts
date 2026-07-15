'use client';

/**
 * The headless half of the Ready moment (W1) and the needs-input chip (W9).
 *
 * Lives in `session-layout` — NOT in `EasyPanel` — because the panel body is
 * exactly the thing the user hasn't opened; the announcement must come from a
 * component that is mounted while the panel is closed.
 *
 * The existing notification system (`notifyTaskComplete`) already covers the
 * away cases (tab hidden, other session) and deliberately stays silent while
 * the user is watching this session with the tab focused — which is exactly
 * the case this chip exists for. No sounds or toasts here, ever.
 */

import { track } from '@/lib/track';
import { useKortixComputerStore, useIsSidePanelOpen } from '@/stores/kortix-computer-store';
import { useOpenCodePendingStore } from '@/stores/opencode-pending-store';
import type { MessageWithParts } from '@/ui';
import { useEffect, useMemo, useRef } from 'react';
import { deriveIsRunning } from '../easy/easy-panel-logic';
import { collectAllToolParts } from './collect-tool-parts';
import {
  chipForCompletion,
  completionYieldsToPendingInput,
  pendingInputCount,
} from './deliverable-readiness';
import { deriveOutputs } from './derive-panels';
import { groupSteps } from './group-steps';
import { latestRunCallIds, latestRunMessages } from './latest-run';
import { selectPrimaryDeliverable } from './output-priority';
import { deriveRunOutcome } from './run-outcome';

/**
 * Sessions whose CURRENT pending-input episode has already been reported to
 * telemetry. Module scope on purpose: the hook lives in `SessionLayout`, which
 * remounts per session (`key={chatSessionId}`), so any per-mount ref would
 * forget and re-fire `ready_chip_shown` for the SAME unanswered episode every
 * time the user switches away and back. The global readyChip slot can't serve
 * as the memory either — another session's chip overwrites it. An entry is
 * cleared when that session's pending count drops to 0 (the episode ended; a
 * future question is genuinely new).
 */
const needsInputReported = new Set<string>();

export function useDeliverableReadiness(
  sessionId: string,
  messages: MessageWithParts[] | undefined,
  isSessionBusy: boolean,
): void {
  const isPanelOpen = useIsSidePanelOpen();

  const parts = useMemo(() => collectAllToolParts(messages), [messages]);
  const steps = useMemo(() => groupSteps(parts), [parts]);
  const isRunning = deriveIsRunning(
    steps.some((s) => s.status === 'running'),
    isSessionBusy,
  );

  // Pending questions/permissions for THIS session — read above the W1 effect
  // because completion has to consult it: a run can settle to idle while a
  // question is still outstanding (idle IS how the agent waits for the answer).
  const pendingForSession = useOpenCodePendingStore((s) =>
    pendingInputCount(s.permissions, s.questions, sessionId),
  );

  const wasRunningRef = useRef(isRunning);
  useEffect(() => {
    const settledNow = wasRunningRef.current && !isRunning;
    wasRunningRef.current = isRunning;
    if (!settledNow || isPanelOpen) return;
    // A standing needs-input chip outranks run completion: if the agent is
    // blocked on the user, being blocked IS the news — writing a ready chip
    // here would silently clobber the needs_input chip the W9 effect owns
    // (which won't re-run on this render if pendingForSession didn't change).
    if (completionYieldsToPendingInput(pendingForSession)) return;

    // Scoped to the latest run's own steps, not the session's — otherwise a
    // text-only turn after an old errored write reads as failed forever
    // (the session-wide last step never moves off 'error').
    const latestSteps = groupSteps(collectAllToolParts(latestRunMessages(messages)));
    const outcome = deriveRunOutcome(messages, latestSteps[latestSteps.length - 1]?.status);
    const outputs = deriveOutputs(parts, { latestRun: latestRunCallIds(messages) });
    const freshDeliverables = outputs.filter((o) => o.fresh);
    const primary = selectPrimaryDeliverable(
      freshDeliverables.filter((o) => o.kind === 'app'),
      freshDeliverables.filter((o) => o.kind !== 'app'),
    );
    const chip = chipForCompletion(
      outcome,
      freshDeliverables.length,
      primary ? (primary.title ?? primary.name) : undefined,
      sessionId,
    );
    if (chip) {
      track('ready_chip_shown', { outcome: chip.outcome });
      useKortixComputerStore.getState().setReadyChip(chip);
    }
  }, [isRunning, isPanelOpen, messages, parts, steps, sessionId, pendingForSession]);

  // W9 — the agent is blocked on the user. This is not a transition: the chip
  // holds for as long as the question does, and yields to nothing (a
  // needs-input chip outranks a ready chip; being blocked outranks being done).
  useEffect(() => {
    // The episode-memory reset lives above the isPanelOpen early-return on
    // purpose: an episode can resolve while the panel is open, and the next
    // question after that must still count as a new episode.
    if (pendingForSession === 0) needsInputReported.delete(sessionId);
    if (isPanelOpen) return;
    const store = useKortixComputerStore.getState();
    if (pendingForSession > 0) {
      // One `ready_chip_shown` per pending-input episode — see
      // `needsInputReported` for why the memory is module-scope, not the
      // (single, globally shared) readyChip slot or a per-mount ref. Only the
      // telemetry emission is gated; the chip write itself stays unconditional.
      if (!needsInputReported.has(sessionId)) {
        needsInputReported.add(sessionId);
        track('ready_chip_shown', { outcome: 'needs_input' });
      }
      store.setReadyChip({ sessionId, outcome: 'needs_input', count: 0 });
    } else if (store.readyChip?.outcome === 'needs_input' && store.readyChip.sessionId === sessionId) {
      store.clearReadyChip();
    }
  }, [pendingForSession, isPanelOpen, sessionId]);
}
