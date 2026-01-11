/**
 * Message grouping utilities for thread rendering
 */

import type { UnifiedMessage, MessageGroup } from '../types/messages';

/**
 * Options for grouping messages with streaming content
 */
export interface GroupingOptions {
  /** Streaming text content to inject */
  streamingTextContent?: string;
  /** Streaming tool call message to inject */
  streamingToolCall?: UnifiedMessage | null;
  /** Whether in read-only/playback mode */
  readOnly?: boolean;
  /** Playback streaming text */
  streamingText?: string;
  /** Whether playback streaming text is active */
  isStreamingText?: boolean;
}

/**
 * Group messages for display:
 * - User messages: standalone
 * - Assistant + following tools: grouped together
 * - Consecutive assistant+tool sequences: merged into one group
 * 
 * Example:
 * [user, assistant, tool, tool, user, assistant, tool]
 * → [user], [assistant+tool+tool], [user], [assistant+tool]
 * 
 * @param messages - Array of unified messages to group
 * @returns Array of message groups for rendering
 */
export function groupMessages(messages: UnifiedMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentAssistantGroup: UnifiedMessage[] = [];
  let assistantGroupCounter = 0;

  messages.forEach((message, index) => {
    const key = message.message_id || `msg-${index}`;

    if (message.type === 'user') {
      // Finalize any existing assistant group
      if (currentAssistantGroup.length > 0) {
        assistantGroupCounter++;
        groups.push({
          type: 'assistant_group',
          messages: currentAssistantGroup,
          key: `assistant-group-${assistantGroupCounter}`,
        });
        currentAssistantGroup = [];
      }

      // Add standalone user message - wrap in array for consistency
      groups.push({
        type: 'user',
        messages: [message],
        key,
      });
    } else if (message.type === 'assistant' || message.type === 'tool' || message.type === 'browser_state') {
      // Check if we can add to existing assistant group (same agent)
      const canAddToExistingGroup = currentAssistantGroup !== null && (() => {
        // For assistant messages, check if agent matches
        if (message.type === 'assistant') {
          const lastAssistantMsg = currentAssistantGroup!.findLast(m => m.type === 'assistant');
          if (!lastAssistantMsg) return true; // No assistant message yet, can add

          // Compare agent info - both null/undefined should be treated as same (default agent)
          const currentAgentId = message.agent_id;
          const lastAgentId = lastAssistantMsg.agent_id;
          return currentAgentId === lastAgentId;
        }
        // For tool/browser_state messages, always add to current group
        return true;
      })();

      if (canAddToExistingGroup) {
        // Add to existing assistant group
        currentAssistantGroup!.push(message);
      } else {
        // Finalize any existing group
        if (currentAssistantGroup && currentAssistantGroup.length > 0) {
          assistantGroupCounter++;
          groups.push({
            type: 'assistant_group',
            messages: currentAssistantGroup,
            key: `assistant-group-${assistantGroupCounter}`,
          });
        }

        // Create a new assistant group
        currentAssistantGroup = [message];
      }
    }
    // Skip 'status', 'system', and other types for now
  });

  // Finalize any remaining assistant group
  if (currentAssistantGroup.length > 0) {
    assistantGroupCounter++;
    groups.push({
      type: 'assistant_group',
      messages: currentAssistantGroup,
      key: `assistant-group-${assistantGroupCounter}`,
    });
  }

  return groups;
}

/**
 * Group messages with streaming content injection
 * Extends base grouping to handle streaming text and tool calls
 * 
 * @param messages - Array of unified messages to group
 * @param options - Streaming options for content injection
 * @returns Array of message groups with streaming content injected
 */
export function groupMessagesWithStreaming(
  messages: UnifiedMessage[],
  options?: GroupingOptions
): MessageGroup[] {
  const {
    streamingTextContent,
    streamingToolCall,
    readOnly = false,
    streamingText,
    isStreamingText = false,
  } = options || {};

  // Start with base grouping
  const baseGroups = groupMessages(messages);
  const mergedGroups = [...baseGroups];
  let assistantGroupCounter = mergedGroups.length;

  // Helper to create a streaming assistant message
  const createStreamingMessage = (content: string, messageId: string): UnifiedMessage => ({
    content,
    type: 'assistant',
    message_id: messageId,
    metadata: messageId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_llm_message: true,
    thread_id: messageId,
    sequence: Infinity,
  });

  // Inject streaming text content
  if (streamingTextContent) {
    const lastGroup = mergedGroups.at(-1);
    if (!lastGroup || lastGroup.type === 'user') {
      // Create new assistant group for streaming text
      mergedGroups.push({
        type: 'assistant_group',
        messages: [createStreamingMessage(streamingTextContent, 'streamingTextContent')],
        key: `streaming-group-text`,
      });
    } else if (lastGroup.type === 'assistant_group') {
      // Add to existing assistant group if not already present
      const lastMessage = lastGroup.messages[lastGroup.messages.length - 1];
      if (lastMessage.message_id !== 'streamingTextContent') {
        lastGroup.messages.push(createStreamingMessage(streamingTextContent, 'streamingTextContent'));
      }
    }
  }

  // Handle streaming tool call (ensure there's a group to render in)
  // This is needed because native tool calls have no text content, only metadata
  if (streamingToolCall && !streamingTextContent) {
    const lastGroup = mergedGroups.at(-1);
    if (!lastGroup || lastGroup.type === 'user') {
      // Create new empty assistant group so streaming tool call can render
      assistantGroupCounter++;
      mergedGroups.push({
        type: 'assistant_group',
        messages: [],
        key: `streaming-group-tool`,
      });
    }
  }

  // Handle playback streaming text (read-only mode)
  if (readOnly && streamingText && isStreamingText) {
    const lastGroup = mergedGroups.at(-1);
    if (!lastGroup || lastGroup.type === 'user') {
      mergedGroups.push({
        type: 'assistant_group',
        messages: [createStreamingMessage(streamingText, 'playbackStreamingText')],
        key: `streaming-group-playback`,
      });
    }
  }

  return mergedGroups;
}

/**
 * Get the first message from a message group
 * Useful for extracting the primary message (e.g., user message or first assistant message)
 * 
 * @param group - The message group
 * @returns The first message, or undefined if group is empty
 */
export function getFirstMessage(group: MessageGroup): UnifiedMessage | undefined {
  return group.messages[0];
}

/**
 * Get the last message from a message group
 * 
 * @param group - The message group
 * @returns The last message, or undefined if group is empty
 */
export function getLastMessage(group: MessageGroup): UnifiedMessage | undefined {
  return group.messages[group.messages.length - 1];
}

/**
 * Filter messages by type within a group
 * 
 * @param group - The message group
 * @param type - The message type to filter for
 * @returns Array of messages matching the type
 */
export function filterMessagesByType(
  group: MessageGroup,
  type: UnifiedMessage['type']
): UnifiedMessage[] {
  return group.messages.filter(m => m.type === type);
}

