'use client';

/**
 * Which surface draws the session plan, as a hook both surfaces read.
 *
 * There are two candidates and they must never both mount: `PlanPanelCard` in
 * the Easy panel's card column, and the plan card under a user message in the
 * transcript. `turn/plan-anchor.ts`'s `planBelongsToChat` holds the rule —
 * desktop is always the panel, mobile is always the chat, and the panel's
 * visibility does not enter into it. Read that function's header before
 * changing anything here; the desktop fallback was removed on purpose.
 *
 * ONE hook, not a predicate copied into each consumer. `session-chat.tsx` and
 * `easy-panel.tsx` each calling `useIsMobile()` separately is how the two
 * surfaces last disagreed; reading one hook means the two answers are the same
 * answer by construction.
 */

import { useIsMobile } from '@/hooks/utils';

import { planBelongsToChat } from './turn/plan-anchor';

/**
 * True when the TRANSCRIPT owns the plan, false when the Easy panel does.
 *
 * Subscribes to viewport width and nothing else. It deliberately does NOT read
 * `isActionPanelOpen` / `isSidePanelOpen` / `panelMode`: those made the plan
 * hop surfaces on every panel toggle, and they also re-rendered the whole
 * transcript each time one of them changed.
 */
export function usePlanInChat(): boolean {
  return planBelongsToChat({ isMobile: useIsMobile() });
}
