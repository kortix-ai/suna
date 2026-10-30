'use client';

/**
 * Renders the Easy panel while the Advanced presentation is disabled.
 *
 * This is the action panel column's root — `session-action-panel-column.tsx`
 * renders it beside the chat. It takes no props: everything it and the cards
 * below it need comes from `SessionPanelProvider`, which owns the session's
 * panel state for both surfaces.
 */

// import { AdvancedPanel } from './advanced/advanced-panel'; // ADVANCED PANEL TEMPORARILY DISABLED
import { EasyPanel } from './easy/easy-panel';

export function ActionPanel() {
  // ADVANCED PANEL TEMPORARILY DISABLED — Easy is the one panel presentation
  // (Easy Panel v2 spec, 2026-07-17). AdvancedPanel and the panelMode
  // preference remain; do not restore the old request-discard effects.
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
