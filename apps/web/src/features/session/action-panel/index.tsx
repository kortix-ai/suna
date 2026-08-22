'use client';

/**
 * Picks which panel presentation to render: `EasyPanel` (the plain-language
 * card home) or `AdvancedPanel` (the tool-call stepper), driven by
 * `preferences.panelMode`.
 *
 * This is the action panel column's root — `session-action-panel-column.tsx`
 * renders it beside the chat. It takes no props: everything it and the cards
 * below it need comes from `SessionPanelProvider`, which owns the session's
 * panel state for both surfaces.
 */

import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { type PanelMode, useUserPreferencesStore } from '@/stores/user-preferences-store';
import { useEffect } from 'react';
// import { AdvancedPanel } from './advanced/advanced-panel'; // ADVANCED PANEL TEMPORARILY DISABLED
import { EasyPanel } from './easy/easy-panel';
import { useOptionalSessionPanel } from './session-panel-provider';

/**
 * Whether Advanced mode should discard a chip's pending "open with the
 * primary deliverable" request for this session (W7). Only `EasyPanel`'s side
 * of the provider reads `pendingPrimaryOpenSessionId`, so Advanced mode never
 * naturally consumes it — left standing, it survives a later switch back to
 * Easy and auto-opens a deliverable the user never asked THIS render to show.
 * Pulled out as a pure predicate (same reasoning as `easy-panel-logic.ts`) so
 * the discard condition is unit-testable without mounting the component or a
 * DOM.
 */
export function shouldDiscardPendingPrimaryOpen(
  mode: PanelMode,
  pendingPrimaryOpenSessionId: string | null,
  sessionId: string,
): boolean {
  return mode === 'advanced' && pendingPrimaryOpenSessionId === sessionId;
}

export function ActionPanel() {
  // Users with preferences persisted before this shipped have no panelMode key.
  const mode = useUserPreferencesStore((s) => s.preferences.panelMode ?? 'easy');
  const panel = useOptionalSessionPanel();
  const sessionId = panel?.sessionId ?? null;

  // Hooks can't be conditional, so these subscribe unconditionally and only
  // act when `shouldDiscardPendingPrimaryOpen` says so (i.e. mode is
  // 'advanced' and the pending request belongs to this session).
  const pendingPrimaryOpenSessionId = useKortixComputerStore(
    (s) => s.pendingPrimaryOpenSessionId,
  );
  useEffect(() => {
    if (!sessionId) return;
    if (!shouldDiscardPendingPrimaryOpen(mode, pendingPrimaryOpenSessionId, sessionId)) return;
    useKortixComputerStore.getState().consumePrimaryOpen(sessionId);
  }, [mode, pendingPrimaryOpenSessionId, sessionId]);

  // Same discard contract for the palette's quick-view request: only the Easy
  // side consumes it, so in Advanced mode it would otherwise survive a later
  // mode switch and replay a Terminal/Audit open the user never asked that
  // render for. (Advanced handles the palette command directly via
  // session-browser-store — see command-palette.tsx.)
  const pendingQuickView = useKortixComputerStore((s) => s.pendingQuickView);
  useEffect(() => {
    if (!sessionId) return;
    if (mode !== 'advanced' || pendingQuickView?.sessionId !== sessionId) return;
    useKortixComputerStore.getState().consumeQuickView(sessionId);
  }, [mode, pendingQuickView, sessionId]);

  // ADVANCED PANEL TEMPORARILY DISABLED — Easy is the one panel presentation
  // (Easy Panel v2 spec, 2026-07-17). Everything advanced-mode is kept intact
  // (advanced/advanced-panel.tsx, the panelMode preference, the discard
  // effects above) so uncommenting this branch restores it wholesale.
  //
  // RE-ENABLING THIS LOSES THE PLAN unless Advanced grows a Plan card too.
  // On desktop the Easy panel is the plan's ONLY surface — the transcript no
  // longer takes it back when the panel is not drawing it (`planBelongsToChat`
  // in turn/plan-anchor.ts, which explains why). `AdvancedPanel` is a
  // tool-call stepper with no cards, so an advanced-mode user would see no
  // plan anywhere. Give Advanced its own `PlanPanelCard`, or make this a
  // condition in `planBelongsToChat` as a deliberate product call.
  //
  // return mode === 'advanced' ? <AdvancedPanel … /> : (
  return <EasyPanel />;
}
