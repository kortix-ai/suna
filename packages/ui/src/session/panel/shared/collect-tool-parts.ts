import { shouldShowToolPart } from '../../../internal/session-types';
import { sessionLogOpenCall, type SessionLogMessage, type ToolCallBlock } from '@kortix/sdk';
import { shouldShowToolPartInActionsPanel } from '../../tool/tool-renderers';

/**
 * Flatten a thread's messages into the ordered list of tool calls worth
 * showing — the same set the chat transcript renders. Every message counts,
 * in or out of context: an errored reply's calls show as they do in the chat.
 *
 * The calls come from `useSessionLogThread` (`session-panel-provider.tsx`),
 * which serves the `fromV1` live view while v2 is off and the API's page on v2.
 * Each call is read through `sessionLogOpenCall`, so a call the page closed at
 * rest (the closure rule) counts as the open call the live view holds, and the
 * panel's running/pending reads agree on both paths.
 *
 * Advanced-only. Applies `shouldShowToolPartInActionsPanel` on top of the
 * universal filter, which deliberately drops `read`, `skill`, and the
 * memory-lookup tools — correct for the one-at-a-time actions stepper, but
 * wrong for Easy mode. See `collectAllToolCalls` below: do NOT merge these
 * two functions back into one, or Easy mode's "Read N files" progress line
 * and its Context card silently go dark again.
 */
export function collectToolCalls(messages: SessionLogMessage[] | undefined): ToolCallBlock[] {
  return collectAllToolCalls(messages).filter(shouldShowToolPartInActionsPanel);
}

/**
 * Same traversal as `collectToolCalls`, but for Easy mode, which needs the
 * calls the Advanced actions-panel filter throws away:
 *   - `read` calls, so Progress can narrate "Read N files" and the Context
 *     card can show "Files read (N)" (see narration.ts's `explore` family).
 *   - the `skill` tool, so narration.ts's `skills` family has anything to
 *     narrate.
 *   - memory-lookup tools, so narration.ts's `memory` family has anything to
 *     narrate.
 * `shouldShowToolPartInActionsPanel` exists specifically to hide those from
 * the Advanced one-at-a-time stepper — applying it here would silently break
 * two of Easy mode's three cards. This function applies only the universal
 * rules (a `tool_call` block and the global `shouldShowToolPart` hidden-part
 * filter); engine noise Easy mode still wants to drop (e.g. context-engine
 * bookkeeping) is filtered later, by `familyForTool(tool) === 'hidden'` in
 * group-steps.ts.
 */
export function collectAllToolCalls(messages: SessionLogMessage[] | undefined): ToolCallBlock[] {
  if (!messages) return [];
  const calls: ToolCallBlock[] = [];
  for (const msg of messages) {
    for (const block of msg.blocks) {
      if (block.type !== 'tool_call') continue;
      const call = sessionLogOpenCall(block);
      if (shouldShowToolPart(call)) calls.push(call);
    }
  }
  return calls;
}
