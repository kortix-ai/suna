/**
 * Shared types for message and streaming handling
 * These types are portable and can be used in both web and mobile apps
 */

/**
 * Unified message structure - the core message type
 * Matches the backend message format
 */
export interface UnifiedMessage {
  message_id: string;
  thread_id: string;
  type: 'user' | 'assistant' | 'tool' | 'status' | 'llm_response_start' | 'llm_response_end';
  is_llm_message: boolean;
  content: string; // JSON string
  metadata: string; // JSON string
  created_at: string;
  updated_at: string;
  sequence?: number;
  agent_id?: string | null;
  agent_version_id?: string | null;
  created_by_user_id?: string | null;
}

/**
 * Parsed content from message.content JSON
 */
export interface ParsedContent {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  name?: string;
  tool_call_id?: string;
  status_type?: string;
  finish_reason?: string;
  [key: string]: any;
}

/**
 * Parsed metadata from message.metadata JSON
 */
export interface ParsedMetadata {
  stream_status?: 'chunk' | 'complete' | 'tool_call_chunk';
  thread_run_id?: string;
  tool_index?: number;
  assistant_message_id?: string;
  linked_tool_result_message_id?: string;
  tool_calls?: Array<{
    tool_call_id: string;
    function_name: string;
    arguments: Record<string, any> | string;
    source: 'native' | 'xml';
  }>;
  text_content?: string;
  function_name?: string;
  result?: {
    success: boolean;
    output: any;
    error?: string | null;
  };
  return_format?: 'native' | 'xml';
  tool_call_id?: string;
  agent_should_terminate?: boolean;
  [key: string]: any;
}

/**
 * Tool call data structure (simplified)
 */
export interface ToolCallData {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, any> | string;
  source: 'native' | 'xml';
}

/**
 * Tool result data structure
 */
export interface ToolResultData {
  success: boolean;
  output: any;
  error?: string | null;
}

/**
 * Message group for rendering
 */
export interface MessageGroup {
  type: 'user' | 'assistant_group';
  messages: UnifiedMessage[];
  key: string;
}

/**
 * Streaming state for UI
 */
export interface StreamingState {
  status: 'idle' | 'connecting' | 'streaming' | 'completed' | 'error' | 'stopped';
  textContent: string;
  toolCall: UnifiedMessage | null;
  error: string | null;
  agentRunId: string | null;
}

/**
 * Agent status
 */
export type AgentStatus = 'idle' | 'running' | 'connecting' | 'error';

/**
 * Tool call display info for UI
 */
export interface ToolCallDisplayInfo {
  toolCallId: string;
  functionName: string;
  displayName: string;
  source: 'native' | 'xml';
  category: 'file' | 'command' | 'web' | 'communication' | 'other';
  primaryParam?: string; // e.g., file path, command
  isAskOrComplete: boolean;
  text?: string; // For ask/complete tools
}

