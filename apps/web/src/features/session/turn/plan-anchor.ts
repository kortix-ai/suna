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
