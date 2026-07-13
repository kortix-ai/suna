import { type MessageWithParts, type ToolPart, isToolPart, shouldShowToolPart } from '@/ui';
import { shouldShowToolPartInActionsPanel } from '../../tool/tool-renderers';

/**
 * Flatten a session's messages into the ordered list of tool calls worth
 * showing — the same set the chat transcript renders. This replaces the old
 * `adaptMessagesToToolCalls` adapter: no conversion to a legacy shape, just
 * the native `ToolPart`s in call order.
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
