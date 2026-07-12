import type { AcpChatItem } from '@kortix/sdk';
import type { MessageWithParts } from '@/hooks/runtime/use-runtime-sessions';

/** Adapt protocol-native ACP message items to the existing context inspector's
 * presentation contract. No transport/runtime state is introduced here. */
export function projectAcpContextMessages(
  items: readonly AcpChatItem[],
  sessionId: string,
  created = Date.now(),
): MessageWithParts[] {
  return items.flatMap((item) => {
    if (item.kind !== 'message') return [];
    const role = item.role === 'user' ? 'user' : 'assistant';
    return [{
      info: { id: item.id, role, sessionID: sessionId, time: { created } },
      parts: [{
        id: `${item.id}-content`,
        messageID: item.id,
        sessionID: sessionId,
        type: item.role === 'thought' ? 'reasoning' : 'text',
        text: item.text,
      }],
    }];
  });
}
