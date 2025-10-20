import { Message } from '@/api/chat-api';
import { safeJsonParse } from './safe-json-parser';

export interface ParsedMetadata {
  stream_status?: 'chunk' | 'complete';
  thread_run_id?: string;
  tool_index?: number;
  assistant_message_id?: string;
  linked_tool_result_message_id?: string;
  parsing_details?: any;
  tool_execution?: {
    function_name?: string;
    xml_tag_name?: string;
    arguments?: Record<string, any>;
    result?: {
      success?: boolean;
      output?: string;
    };
    execution_details?: {
      timestamp?: string;
    };
    tool_call_id?: string;
  };
  [key: string]: any;
}

export interface ParsedContent {
  content?: string;
  tool_execution?: ParsedMetadata['tool_execution'];
  summary?: string;
  [key: string]: any;
}

export function parseMessageMetadata(message: Message): ParsedMetadata {
  if (!message.metadata) return {};
  
  return safeJsonParse<ParsedMetadata>(
    typeof message.metadata === 'string' ? message.metadata : JSON.stringify(message.metadata),
    {}
  );
}

export function parseMessageContent(message: Message): ParsedContent {
  if (!message.content) return {};
  
  return safeJsonParse<ParsedContent>(
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    {}
  );
}

export function extractContentText(message: Message): string {
  if (typeof message.content === 'string') {
    const parsed = safeJsonParse(message.content, message.content);
    
    if (typeof parsed === 'object' && parsed !== null && 'content' in parsed) {
      return String((parsed as any).content || '');
    }
    
    if (typeof parsed === 'string') {
      return parsed;
    }
    
    return message.content;
  }
  
  if (typeof message.content === 'object' && message.content !== null) {
    if ('content' in message.content && typeof message.content.content === 'string') {
      return message.content.content;
    }
    
    const jsonStr = JSON.stringify(message.content);
    const parsed = safeJsonParse(jsonStr, message.content);
    
    if (typeof parsed === 'object' && parsed !== null && 'content' in parsed) {
      return String((parsed as any).content || '');
    }
    
    return '';
  }
  
  return String(message.content || '');
}

export function findLinkedToolResults(
  assistantMessage: Message,
  allMessages: Message[]
): Message[] {
  if (!assistantMessage.message_id) return [];
  
  return allMessages.filter(msg => {
    if (!msg.is_llm_message) return false;
    
    const metadata = parseMessageMetadata(msg);
    return metadata.assistant_message_id === assistantMessage.message_id;
  });
}

export function groupRelatedMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const processedIds = new Set<string>();
  
  for (const message of messages) {
    if (processedIds.has(message.message_id)) continue;
    
    if (message.type === 'user') {
      groups.push({
        type: 'user',
        primary: message,
        related: [],
      });
      processedIds.add(message.message_id);
    } else if (message.type === 'assistant' || message.is_llm_message) {
      const toolResults = findLinkedToolResults(message, messages);
      
      groups.push({
        type: 'assistant',
        primary: message,
        related: toolResults,
      });
      
      processedIds.add(message.message_id);
      toolResults.forEach(tool => processedIds.add(tool.message_id));
    } else if (!processedIds.has(message.message_id)) {
      groups.push({
        type: 'other',
        primary: message,
        related: [],
      });
      processedIds.add(message.message_id);
    }
  }
  
  return groups;
}

export function isStreamingMessage(message: Message): boolean {
  const metadata = parseMessageMetadata(message);
  return metadata.stream_status === 'chunk';
}

export function isCompleteMessage(message: Message): boolean {
  const metadata = parseMessageMetadata(message);
  return metadata.stream_status === 'complete';
}

export function getToolExecutionFromMessage(message: Message): ParsedMetadata['tool_execution'] | null {
  const metadata = parseMessageMetadata(message);
  if (metadata.tool_execution) return metadata.tool_execution;
  
  const content = parseMessageContent(message);
  if (content.tool_execution) return content.tool_execution;
  
  return null;
}

export interface MessageGroup {
  type: 'user' | 'assistant' | 'other';
  primary: Message;
  related: Message[];
} 