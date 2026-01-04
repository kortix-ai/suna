import type { Project } from '@/lib/api/threads';
import { Message as BaseApiMessageType } from '@/lib/api/threads';

// Re-export shared types - single source of truth
export type {
  UnifiedMessage,
  ParsedContent,
  ParsedMetadata,
  AgentStatus,
} from '@agentpress/shared';

// Re-export streaming types from shared
export type {
  StreamStatus,
  StreamMessage,
  ChunkMessage,
  StatusMessage,
  ToolCallStreamMessage,
  ToolOutputMessage,
  ErrorStreamMessage,
  PingMessage,
  LlmResponseStartMessage,
  StreamingToolCall,
  StreamingMetadata,
} from '@agentpress/shared';

export { StreamMessageType, validateStreamMessage } from '@agentpress/shared';

// Define a type for the params to make React.use() work properly
export type ThreadParams = {
  threadId: string;
  projectId: string;
};

// Extend the base Message type with the expected database fields
export interface ApiMessageType extends Omit<BaseApiMessageType, 'type'> {
  message_id?: string;
  thread_id?: string;
  is_llm_message?: boolean;
  metadata?: string;
  created_at?: string;
  updated_at?: string;
  // Allow 'type' to be potentially wider than the base type
  type?: string;
}

// Re-export existing types
export type { Project };
