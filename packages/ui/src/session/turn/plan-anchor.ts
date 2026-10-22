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
import { shouldShowToolPart, toolKind, type SessionLogTurn } from '@kortix/sdk';

/**
 * A tool call that writes the plan. The runtime emits more than one spelling
 * (`todowrite`, `todo_write`); `toolKind` owns them. The todo READ shares the
 * kind and never renders (`shouldShowToolPart`), so it is not a plan write.
 * @deprecated Renders an OpenCode-only tool or todo list in an OpenCode session (pi has none). OpenCode is sunset (2026-10-23): no new code; delete with OpenCode.
 */
export function isPlanWriteTool(tool: string): boolean {
  return toolKind(tool) === 'todowrite' && shouldShowToolPart({ tool });
}

/**
 * The turn that owns the plan card: `SessionLogTurn.plan` (`sessionLogTurns`),
 * the last turn that wrote the todos, else the last turn — the session may
 * still hold todos with no write in the loaded history (compaction drops old
 * blocks, and the todo list comes from the runtime), so the plan stays
 * reachable. Null with no turn.
 */
export function planAnchorMessageId(turns: ReadonlyArray<Pick<SessionLogTurn, 'id' | 'plan'>>): string | null {
  return turns.find((turn) => turn.plan)?.id ?? null;
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
 * with no Plan card, but it is commented out today (`panel/action-panel.tsx`)
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

/** @deprecated Renders an OpenCode-only tool or todo list in an OpenCode session (pi has none). OpenCode is sunset (2026-10-23): no new code; delete with OpenCode. */
export function planBelongsToChat(state: PlanSurfaceState): boolean {
  return state.isMobile;
}

/**
 * The anchor the CHAT should use — which is "none" unless the chat is the
 * plan's surface, per `planBelongsToChat`.
 *
 * The gate wraps the lookup rather than sitting beside it: returning `null` (which matches no message id) means every `ownsPlan`
 * downstream, including the user bubble's own column cap, falls out of ONE
 * decision instead of two that can disagree.
 * @deprecated Renders an OpenCode-only tool or todo list in an OpenCode session (pi has none). OpenCode is sunset (2026-10-23): no new code; delete with OpenCode.
 */
export function chatPlanAnchorId(
  turns: ReadonlyArray<Pick<SessionLogTurn, 'id' | 'plan'>> | null | undefined,
  chatOwnsPlan: boolean,
): string | null {
  if (!chatOwnsPlan || !turns) return null;
  return planAnchorMessageId(turns);
}
