/**
 * Streaming-specific types for real-time message handling
 */

/**
 * Tool call data structure from metadata during streaming
 */
export interface StreamingToolCall {
  tool_call_id: string;
  function_name: string;
  /** Object when complete, string when partial/streaming */
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
}

/**
 * Parsed metadata from streaming messages
 */
export interface StreamingMetadata {
  stream_status?: 'chunk' | 'complete' | 'tool_call_chunk';
  thread_run_id?: string;
  tool_calls?: StreamingToolCall[];
  [key: string]: any;
}

/**
 * Extracted ask/complete content from streaming
 */
export interface AskCompleteContent {
  toolType: 'ask' | 'complete';
  text: string;
}

