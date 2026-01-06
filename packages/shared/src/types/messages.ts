/**
 * Core message types matching backend schema
 * Single source of truth for both frontend and mobile
 */

/**
 * Unified Message Interface matching the backend/database schema
 * Used for all message types in the thread
 */
export interface UnifiedMessage {
  /** Unique message ID, null for transient stream chunks */
  message_id: string | null;
  /** Thread this message belongs to */
  thread_id: string;
  /** Message type */
  type:
    | 'user'
    | 'assistant'
    | 'tool'
    | 'system'
    | 'status'
    | 'browser_state'
    | 'image_context'
    | 'llm_response_end'
    | 'llm_response_start';
  /** Whether this message is from the LLM */
  is_llm_message: boolean;
  /** JSON string containing the message content */
  content: string;
  /** JSON string containing message metadata */
  metadata: string;
  /** ISO timestamp string */
  created_at: string;
  /** ISO timestamp string */
  updated_at: string;
  /** ID of the agent associated with this message */
  agent_id?: string;
  /** Sequence number for ordering */
  sequence?: number;
  /** Sandbox ID for file access */
  sandbox_id?: string;
  /** Agent information from join (optional) */
  agents?: { name: string };
}

/**
 * Parsed content structure from message.content JSON string
 * Structure depends on message.type
 */
export interface ParsedContent {
  /** Message role */
  role?: 'user' | 'assistant' | 'tool' | 'system';
  /** Actual content - can be string, object, etc. after parsing */
  content?: any;
  /** Native tool calls */
  tool_calls?: any[];
  /** Tool call ID for tool results */
  tool_call_id?: string;
  /** Tool name for tool results */
  name?: string;
  /** Status type for status messages */
  status_type?: string;
  /** Function name for tools */
  function_name?: string;
  /** XML tag name for tool */
  xml_tag_name?: string;
  /** Tool arguments */
  arguments?: any;
  /** Index of tool in sequence */
  tool_index?: number;
  /** Tool result */
  result?: any;
  /** Tool execution error flag */
  is_error?: boolean;
  /** Error/status message text */
  message?: string;
  /** Usage stats for llm_response_end messages */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  /** Allow other properties */
  [key: string]: any;
}

/**
 * Parsed metadata structure from message.metadata JSON string
 */
export interface ParsedMetadata {
  /** Streaming status for assistant messages */
  stream_status?: 'chunk' | 'complete' | 'tool_call_chunk';
  /** Thread run ID */
  thread_run_id?: string;
  /** LLM response ID */
  llm_response_id?: string;
  /** Tool index */
  tool_index?: number;
  /** Link tool results/statuses back to assistant message */
  assistant_message_id?: string;
  /** Link status to tool result */
  linked_tool_result_message_id?: string;
  /** Tool calls array - new format, directly in metadata */
  tool_calls?: Array<{
    tool_call_id: string;
    function_name: string;
    /** Can be string (partial JSON during streaming) or object (complete) */
    arguments: Record<string, any> | string;
    source: 'native' | 'xml';
    /** Whether this is a delta update */
    is_delta?: boolean;
    /** Delta string for streaming */
    arguments_delta?: string;
    /** Index in the tool call sequence */
    index?: number;
    /** Whether this tool call is completed */
    completed?: boolean;
    /** Tool result if completed */
    tool_result?: any;
  }>;
  /** Text content */
  text_content?: string;
  /** Function name - stored directly in metadata, not in result */
  function_name?: string;
  /** Tool result */
  result?: {
    success: boolean;
    output: any;
    error?: string | null;
  };
  /** Return format for tool calls */
  return_format?: 'native' | 'xml';
  /** Tool call ID */
  tool_call_id?: string;
  /** Allow other properties */
  [key: string]: any;
}

/**
 * Message group for rendering
 * Groups consecutive assistant+tool messages together
 */
export interface MessageGroup {
  type: 'user' | 'assistant_group';
  messages: UnifiedMessage[];
  key: string;
}

/**
 * Agent status for UI state
 */
export type AgentStatus = 'idle' | 'running' | 'connecting' | 'error';

