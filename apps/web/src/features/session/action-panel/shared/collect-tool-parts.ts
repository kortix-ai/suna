import { type MessageWithParts, type ToolPart, isToolPart, shouldShowToolPart } from '@/ui';
import { shouldShowToolPartInActionsPanel } from '../../tool/tool-renderers';

/**
 * Flatten a session's messages into the ordered list of tool calls worth
 * showing — the same set the chat transcript renders. This replaces the old
 * `adaptMessagesToToolCalls` adapter: no conversion to a legacy shape, just
 * the native `ToolPart`s in call order.
 *
 * Advanced-only. Applies `shouldShowToolPartInActionsPanel` on top of the
 * universal filter, which deliberately drops `read`, `skill`, and the
 * memory-lookup tools — correct for the one-at-a-time actions stepper, but
 * wrong for Easy mode. See `collectAllToolParts` below: do NOT merge these
 * two functions back into one, or Easy mode's "Read N files" progress line
 * and its Context card silently go dark again.
 */
export function collectToolParts(messages: MessageWithParts[] | undefined): ToolPart[] {
  if (!messages) return [];
  const parts: ToolPart[] = [];
  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (
        isToolPart(part) &&
        part.tool !== 'todoread' &&
        shouldShowToolPart(part as ToolPart) &&
        shouldShowToolPartInActionsPanel(part as ToolPart)
      ) {
        parts.push(part as ToolPart);
      }
    }
  }
  return parts;
}

/**
 * Same traversal as `collectToolParts`, but for Easy mode, which needs the
 * parts the Advanced actions-panel filter throws away:
 *   - `read` parts, so Progress can narrate "Read N files" and the Context
 *     card can show "Files read (N)" (see narration.ts's `explore` family).
 *   - the `skill` tool, so narration.ts's `skills` family has anything to
 *     narrate.
 *   - memory-lookup tools, so narration.ts's `memory` family has anything to
 *     narrate.
 * `shouldShowToolPartInActionsPanel` exists specifically to hide those from
 * the Advanced one-at-a-time stepper — applying it here would silently break
 * two of Easy mode's three cards. This function applies only the universal
 * rules (`isToolPart`, the `todoread` exclusion, and the global
 * `shouldShowToolPart` hidden-part filter); engine noise Easy mode still
 * wants to drop (e.g. context-engine bookkeeping) is filtered later, by
 * `familyForTool(tool) === 'hidden'` in group-steps.ts.
 */
export function collectAllToolParts(messages: MessageWithParts[] | undefined): ToolPart[] {
  if (!messages) return [];
  const parts: ToolPart[] = [];
  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (isToolPart(part) && part.tool !== 'todoread' && shouldShowToolPart(part as ToolPart)) {
        parts.push(part as ToolPart);
      }
    }
  }
  return parts;
}
