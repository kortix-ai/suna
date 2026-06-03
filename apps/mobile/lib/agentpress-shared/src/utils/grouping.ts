import type { UnifiedMessage, MessageGroup } from '../types/messages';

export interface GroupingOptions {
  streamingTextContent?: string;
  streamingToolCall?: UnifiedMessage | null;
  readOnly?: boolean;
  streamingText?: string;
  isStreamingText?: boolean;
}

export function groupMessages(messages: UnifiedMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentGroup: MessageGroup | null = null;

  for (const msg of messages) {
    if (msg.type === 'user') {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = null;
      groups.push({
        type: 'user',
        messages: [msg],
        key: `user-${msg.message_id || msg.created_at}`,
      });
    } else {
      if (!currentGroup) {
        currentGroup = {
          type: 'assistant_group',
          messages: [],
          key: `assistant-${msg.message_id || msg.created_at}`,
        };
      }
      currentGroup.messages.push(msg);
    }
  }

  if (currentGroup) groups.push(currentGroup);
  return groups;
}

export function groupMessagesWithStreaming(
  messages: UnifiedMessage[],
  _options?: GroupingOptions
): MessageGroup[] {
  return groupMessages(messages);
}
