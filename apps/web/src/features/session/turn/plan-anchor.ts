/**
 * Which user message owns the plan card.
 *
 * `PlanCard` renders LIVE session todo state (`useRuntimeSessionTodo` + the
 * `todo.updated` SSE event), so exactly ONE turn may show it — the same
 * checklist repeated under every message would read as several plans.
 *
 * That single slot used to be "the last turn". The plan therefore migrated
 * onto each new message the user sent, even when that message never touched
 * the plan: ask a follow-up question, and the checklist from three turns ago
 * reappeared underneath it as though the question had produced it.
 *
 * Anchor it to the turn that actually wrote the todos instead. A later
 * re-plan moves the anchor forward, because that turn is now where the plan
 * was made.
 *
 * ONLY ASKED WHEN THE CHAT OWNS THE PLAN. The Easy panel draws it instead
 * whenever its card column is actually on screen — that card is session-scoped
 * and needs no anchor at all. `planBelongsToChat` below decides which surface
 * is live, and `chatPlanAnchorId` turns this whole module off for the other.
 * See `action-panel/easy/plan-card.tsx`.
 *
 * No React import. Every rule here is unit-tested in plan-anchor.test.ts.
 */
import { isToolPart, type MessageWithParts } from '@/ui';

/**
 * Both spellings reach the UI — the registry registers `todowrite` and
 * `todo_write`, and `action-panel/shared/narration.ts` maps both to "plan".
 */
export function isPlanWriteTool(tool: string): boolean {
  return tool === 'todowrite' || tool === 'todo_write';
}

export function planAnchorMessageId(
  allMessages: ReadonlyArray<MessageWithParts>,
): string | null {
  let currentUserId: string | null = null;
  let anchorId: string | null = null;
  let lastUserId: string | null = null;

  for (const message of allMessages) {
    if (message.info.role === 'user') {
      currentUserId = message.info.id;
      lastUserId = message.info.id;
      continue;
    }

    // A todo write before any user message belongs to no turn — skip it
    // rather than anchoring the card above the transcript.
    if (currentUserId === null) continue;

    if (message.parts.some((part) => isToolPart(part) && isPlanWriteTool(part.tool))) {
      anchorId = currentUserId;
    }
  }

  // No turn wrote todos, yet the session may still hold some: compaction drops
  // old parts, and the todo list comes from the runtime rather than from the
  // transcript. Fall back to the last turn so the plan stays reachable.
  return anchorId ?? lastUserId;
}

/**
 * Where the plan is drawn right now.
 *
 * Exactly one surface may mount it: `PlanPanelCard` in the Easy panel, or the
 * card under a user message in the transcript. Two would render the same live
 * checklist twice; zero would lose it.
 *
 * DESKTOP IS ALWAYS THE PANEL. Above 768px the Easy panel's Plan card is the
 * plan's only home — including when the column is collapsed (the chevron, or
 * Cmd/Ctrl+I) and when a detail panel covers it. The plan does NOT reappear in
 * the transcript in either state.
 *
 * That reverses an earlier version of this predicate, which treated the chat
 * as a fallback for every state where the column was off screen. The fallback
 * is gone on purpose: a live checklist that MOVES between two places as you
 * collapse a panel or open a file is worse than one that is reliably in a
 * single place. You learn where the plan lives once, and bringing the panel
 * back is one keypress.
 *
 * So do NOT re-add a `panelOpen` / `detailOpen` / "the column is hidden"
 * branch here. A hidden panel is a hidden plan, deliberately. Changing that is
 * a product call, not a bug fix.
 *
 * Mobile is the one exception, and it is structural rather than a fallback:
 * under 768px `session-action-panel-column.tsx` returns null, so no panel
 * column exists at any time — the cards are a drawer that is shut by default,
 * and the transcript is the only surface always on screen.
 *
 * Advanced mode is deliberately NOT a condition either. It renders a stepper
 * with no Plan card, but it is commented out today (`action-panel/index.tsx`)
 * and every user gets the Easy panel whatever their stored `panelMode`, so a
 * branch here would only misroute the plan. Re-enabling Advanced must give it
 * a Plan card of its own — see the note at that commented-out branch.
 *
 * Pure, and the single source both surfaces read (through `usePlanInChat`),
 * so they cannot disagree about who owns the plan.
 */
export interface PlanSurfaceState {
  /** Under 768px there is no panel column at all — only a drawer, shut by
   *  default. See `session-action-panel-column.tsx`. This is the entire rule:
   *  whether the panel is OPEN deliberately does not enter into it. */
  isMobile: boolean;
}

export function planBelongsToChat(state: PlanSurfaceState): boolean {
  return state.isMobile;
}

/**
 * The anchor the CHAT should use — which is "none" unless the chat is the
 * plan's surface, per `planBelongsToChat`.
 *
 * The gate wraps the scan rather than sitting beside it, for two reasons.
 * `planAnchorMessageId` walks every part of every message — where the panel
 * owns the plan that is work with no consumer, and skipping it is free. And
 * returning `null` (which matches no message id) means every `ownsPlan`
 * downstream, including the user bubble's own column cap, falls out of ONE
 * decision instead of two that can disagree.
 */
export function chatPlanAnchorId(
  allMessages: ReadonlyArray<MessageWithParts> | null | undefined,
  chatOwnsPlan: boolean,
): string | null {
  if (!chatOwnsPlan || !allMessages) return null;
  return planAnchorMessageId(allMessages);
}
