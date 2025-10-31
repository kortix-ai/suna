/**
 * Message Grouping Utility
 * 
 * Groups messages for rendering: user messages standalone, assistant+tool messages grouped together
 */

import type { UnifiedMessage } from '@/api/types';

export type MessageGroup = 
  | { type: 'user'; message: UnifiedMessage; key: string }
  | { type: 'assistant_group'; messages: UnifiedMessage[]; key: string };

/**
 * Groups messages for display:
 * - User messages: standalone
 * - Assistant + following tools: grouped together
 * - Consecutive assistant+tool sequences: merged into one group
 * 
 * Example:
 * [user, assistant, tool, tool, user, assistant, tool]
 * → [user], [assistant+tool+tool], [user], [assistant+tool]
 */
export function groupMessages(messages: UnifiedMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentAssistantGroup: UnifiedMessage[] | null = null;
  let assistantGroupCounter = 0;

  messages.forEach((message, index) => {
    const key = message.message_id || `msg-${index}`;

    if (message.type === 'user') {
      // Finalize any existing assistant group
      if (currentAssistantGroup && currentAssistantGroup.length > 0) {
        assistantGroupCounter++;
        groups.push({
          type: 'assistant_group',
          messages: currentAssistantGroup,
          key: `assistant-group-${assistantGroupCounter}`,
        });
        currentAssistantGroup = null;
      }

      // Add standalone user message
      groups.push({
        type: 'user',
        message,
        key,
      });
    } else if (message.type === 'assistant' || message.type === 'tool' || message.type === 'browser_state') {
      // Check if we can add to existing assistant group (same agent)
      const canAddToExistingGroup = currentAssistantGroup !== null && (() => {
        // For assistant messages, check if agent matches
        if (message.type === 'assistant') {
          const lastAssistantMsg = currentAssistantGroup.findLast(m => m.type === 'assistant');
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
  if (currentAssistantGroup !== null && (currentAssistantGroup as UnifiedMessage[]).length > 0) {
    assistantGroupCounter++;
    groups.push({
      type: 'assistant_group',
      messages: currentAssistantGroup as UnifiedMessage[],
      key: `assistant-group-${assistantGroupCounter}`,
    });
  }

  return groups;
}

/**
 * Safe JSON parse with fallback
 * Handles both string JSON and pre-parsed objects from API
 */
export function safeJsonParse<T>(
  jsonString: string | Record<string, any> | undefined | null,
  defaultValue: T
): T {
  if (!jsonString) {
    return defaultValue;
  }
  
  // Handle pre-parsed objects (from API)
  if (typeof jsonString === 'object') {
    return jsonString as T;
  }
  
  // Handle string JSON
  if (typeof jsonString !== 'string') {
    return defaultValue;
  }
  
  try {
    const parsed = JSON.parse(jsonString);
    
    // Handle double-escaped JSON (rare but happens)
    if (typeof parsed === 'string' && 
        (parsed.startsWith('{') || parsed.startsWith('['))) {
      try {
        return JSON.parse(parsed) as T;
      } catch {
        return parsed as unknown as T;
      }
    }
    
    return parsed as T;
  } catch {
    return defaultValue;
  }
}


