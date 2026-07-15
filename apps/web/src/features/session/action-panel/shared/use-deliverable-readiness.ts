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

import { useKortixComputerStore, useIsSidePanelOpen } from '@/stores/kortix-computer-store';
import { useOpenCodePendingStore } from '@/stores/opencode-pending-store';
import type { MessageWithParts } from '@/ui';
import { useEffect, useMemo, useRef } from 'react';
import { deriveIsRunning } from '../easy/easy-panel-logic';
import { collectAllToolParts } from './collect-tool-parts';
import { chipForCompletion } from './deliverable-readiness';
import { deriveOutputs } from './derive-panels';
import { groupSteps } from './group-steps';
import { latestRunCallIds } from './latest-run';
import { selectPrimaryDeliverable } from './output-priority';
import { deriveRunOutcome } from './run-outcome';

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

  const wasRunningRef = useRef(isRunning);
  useEffect(() => {
    const settledNow = wasRunningRef.current && !isRunning;
    wasRunningRef.current = isRunning;
    if (!settledNow || isPanelOpen) return;

    const outcome = deriveRunOutcome(messages, steps[steps.length - 1]?.status);
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
    if (chip) useKortixComputerStore.getState().setReadyChip(chip);
  }, [isRunning, isPanelOpen, messages, parts, steps, sessionId]);

  // W9 — the agent is blocked on the user. This is not a transition: the chip
  // holds for as long as the question does, and yields to nothing (a
  // needs-input chip outranks a ready chip; being blocked outranks being done).
  const pendingForSession = useOpenCodePendingStore((s) => {
    const perms = Object.values(s.permissions).filter((p) => p.sessionID === sessionId).length;
    const questions = Object.values(s.questions).filter((q) => q.sessionID === sessionId).length;
    return perms + questions;
  });
  useEffect(() => {
    if (isPanelOpen) return;
    const store = useKortixComputerStore.getState();
    if (pendingForSession > 0) {
      store.setReadyChip({ sessionId, outcome: 'needs_input', count: 0 });
    } else if (store.readyChip?.outcome === 'needs_input' && store.readyChip.sessionId === sessionId) {
      store.clearReadyChip();
    }
  }, [pendingForSession, isPanelOpen, sessionId]);
}
