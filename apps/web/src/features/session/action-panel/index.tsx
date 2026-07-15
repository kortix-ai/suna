'use client';

/**
 * Picks which panel presentation to render for a session: `EasyPanel` (the
 * plain-language card home) or `AdvancedPanel` (the tool-call stepper),
 * driven by `preferences.panelMode`.
 *
 * `isSessionBusy` (the session's own busy/retry status, computed once in
 * `session-layout.tsx`) only matters to `EasyPanel` — it ORs this with its own
 * part-derived running flag so an inter-tool-call gap doesn't read as
 * "finished". `AdvancedPanel` derives its own presentation per tool part and
 * never needs a session-wide running flag.
 */

import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { type PanelMode, useUserPreferencesStore } from '@/stores/user-preferences-store';
import type { MessageWithParts } from '@/ui';
import { useEffect } from 'react';
import { AdvancedPanel } from './advanced/advanced-panel';
import { EasyPanel } from './easy/easy-panel';

/**
 * Whether Advanced mode should discard a chip's pending "open with the
 * primary deliverable" request for this session (W7). Only `EasyPanel` reads
 * `pendingPrimaryOpenSessionId`, so Advanced mode never naturally consumes
 * it — left standing, it survives a later switch back to Easy and
 * auto-opens a deliverable the user never asked THIS render to show. Pulled
 * out as a pure predicate (same reasoning as `easy-panel-logic.ts`) so the
 * discard condition is unit-testable without mounting the component or a DOM.
 */
export function shouldDiscardPendingPrimaryOpen(
  mode: PanelMode,
  pendingPrimaryOpenSessionId: string | null,
  sessionId: string,
): boolean {
  return mode === 'advanced' && pendingPrimaryOpenSessionId === sessionId;
}

export function ActionPanel({
  sessionId,
  messages,
  isSessionBusy = false,
}: {
  sessionId: string;
  messages: MessageWithParts[] | undefined;
  isSessionBusy?: boolean;
}) {
  // Users with preferences persisted before this shipped have no panelMode key.
  const mode = useUserPreferencesStore((s) => s.preferences.panelMode ?? 'easy');

  // Hooks can't be conditional, so this subscribes unconditionally and only
  // acts when `shouldDiscardPendingPrimaryOpen` says so (i.e. mode is
  // 'advanced' and the pending request belongs to this session).
  const pendingPrimaryOpenSessionId = useKortixComputerStore(
    (s) => s.pendingPrimaryOpenSessionId,
  );
  useEffect(() => {
    if (!shouldDiscardPendingPrimaryOpen(mode, pendingPrimaryOpenSessionId, sessionId)) return;
    useKortixComputerStore.getState().consumePrimaryOpen(sessionId);
  }, [mode, pendingPrimaryOpenSessionId, sessionId]);

  return mode === 'advanced' ? (
    <AdvancedPanel sessionId={sessionId} messages={messages} />
  ) : (
    <EasyPanel sessionId={sessionId} messages={messages} isSessionBusy={isSessionBusy} />
  );
}
