import type { AcpChatItem } from '@kortix/sdk';
import type { MessageWithParts } from '@/ui';
import { acpToolCallToPart } from './acp-tool-call-card';

/**
 * Project an ACP session's `chatItems` into the `MessageWithParts[]` shape the
 * action-panel subsystem (`ActionPanel` → `EasyPanel`/`AdvancedPanel`,
 * `useDeliverableReadiness`) reads.
 *
 * The top-level ACP session's data lives in `acp.chatItems`, NOT the runtime
 * sync store (which only holds CHILD-session messages, seeded by the spawn/task
 * tools). Main's `session-layout.tsx` fed the panel `useOpenCodeMessages`; the
 * ACP equivalent is this projection, so the shipped Easy panel renders the same
 * tool-call data it always has.
 *
 * Each item becomes its own message so chronological order is preserved for the
 * downstream flatteners (`collectAllToolParts` walks messages then parts in
 * order) and `latestRunMessages` can slice at the last `role: 'user'` message:
 *   - a `message` item → a user/assistant message carrying one text (or, for a
 *     `thought`, `reasoning`) part — mirrors `acp-session-chat.tsx`'s
 *     `contextMessages` projection exactly.
 *   - a `tool` item → an assistant message carrying that one tool part, via the
 *     same `acpToolCallToPart` adapter the transcript and the old
 *     `SessionActionsPanel` used.
 * Non-visual items (`plan`/`permission`/`question`/`raw`) carry no tool or text
 * the panel cards render, so they are skipped.
 */
export function acpItemsToPanelMessages(
  acpItems: AcpChatItem[] | undefined,
  sessionId: string,
): MessageWithParts[] {
  if (!acpItems || acpItems.length === 0) return [];
  const messages: MessageWithParts[] = [];
  for (const item of acpItems) {
    if (item.kind === 'message') {
      const role = item.role === 'user' ? ('user' as const) : ('assistant' as const);
      messages.push({
        info: {
          id: item.id,
          role,
          sessionID: sessionId,
          time: { created: 0 },
        },
        parts: [
          {
            id: `${item.id}-content`,
            messageID: item.id,
            sessionID: sessionId,
            type: item.role === 'thought' ? ('reasoning' as const) : ('text' as const),
            text: item.text,
          },
        ],
      });
    } else if (item.kind === 'tool') {
      const part = acpToolCallToPart(item, sessionId);
      messages.push({
        info: {
          id: part.id,
          role: 'assistant' as const,
          sessionID: sessionId,
          time: { created: 0 },
        },
        parts: [part],
      });
    }
  }
  return messages;
}
