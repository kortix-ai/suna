/**
 * Streaming-specific types for real-time message handling
 */

/**
 * Stream connection status
 */
export type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'completed' | 'stopped' | 'failed' | 'error';

/**
 * Message types for websocket streaming events
 */
export enum StreamMessageType {
  CHUNK = 'chunk',
  STATUS = 'status',
  TOOL_CALL = 'tool_call',
  TOOL_OUTPUT = 'tool_output',
  LLM_RESPONSE_START = 'llm_response_start',
  ERROR = 'error',
  PING = 'ping',
}

/**
 * Base interface for all stream messages
 */
export interface BaseStreamMessage {
  type: StreamMessageType;
  thread_id: string;
  sequence?: number;
}

/**
 * Content chunk message from streaming
 */
export interface ChunkMessage extends BaseStreamMessage {
  type: StreamMessageType.CHUNK;
  content: string;
}

/**
 * Status update message from streaming
 */
export interface StatusMessage extends BaseStreamMessage {
  type: StreamMessageType.STATUS;
  status: StreamStatus;
}

/**
 * Tool call message from streaming
 */
export interface ToolCallStreamMessage extends BaseStreamMessage {
  type: StreamMessageType.TOOL_CALL;
  tool_call_id: string;
  function_name: string;
  arguments?: string | Record<string, unknown>;
  arguments_delta?: string;
  is_delta?: boolean;
  index?: number;
}

/**
 * Tool output/result message from streaming
 */
export interface ToolOutputMessage extends BaseStreamMessage {
  type: StreamMessageType.TOOL_OUTPUT;
  tool_call_id: string;
  tool_name: string;
  output: string;
  is_final?: boolean;
}

/**
 * Error message from streaming
 */
export interface ErrorStreamMessage extends BaseStreamMessage {
  type: StreamMessageType.ERROR;
  error?: string;
  message?: string;
}

/**
 * Ping/keepalive message from streaming
 */
export interface PingMessage extends BaseStreamMessage {
  type: StreamMessageType.PING;
}

/**
 * LLM response start message from streaming
 */
export interface LlmResponseStartMessage extends BaseStreamMessage {
  type: StreamMessageType.LLM_RESPONSE_START;
}

/**
 * Union type of all stream messages
 */
export type StreamMessage =
  | ChunkMessage
  | StatusMessage
  | ToolCallStreamMessage
  | ToolOutputMessage
  | ErrorStreamMessage
  | PingMessage
  | LlmResponseStartMessage;

/**
 * Validate and parse incoming stream message data
 */
export function validateStreamMessage(data: unknown): StreamMessage | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const obj = data as Record<string, unknown>;
  const type = obj.type as string;

  switch (type) {
    case 'chunk':
    case 'assistant_chunk':
      return {
        type: StreamMessageType.CHUNK,
        thread_id: (obj.thread_id as string) || '',
        content: (obj.content as string) || '',
        sequence: obj.sequence as number | undefined,
      } as ChunkMessage;

    case 'status':
      return {
        type: StreamMessageType.STATUS,
        thread_id: (obj.thread_id as string) || '',
        status: (obj.status as StreamStatus) || 'idle',
        sequence: obj.sequence as number | undefined,
      } as StatusMessage;

    case 'tool_call':
    case 'tool_call_chunk':
      return {
        type: StreamMessageType.TOOL_CALL,
        thread_id: (obj.thread_id as string) || '',
        tool_call_id: (obj.tool_call_id as string) || '',
        function_name: (obj.function_name as string) || '',
        arguments: obj.arguments as string | Record<string, unknown> | undefined,
        arguments_delta: obj.arguments_delta as string | undefined,
        is_delta: obj.is_delta as boolean | undefined,
        index: obj.index as number | undefined,
        sequence: obj.sequence as number | undefined,
      } as ToolCallStreamMessage;

    case 'tool_output':
    case 'tool_result':
      return {
        type: StreamMessageType.TOOL_OUTPUT,
        thread_id: (obj.thread_id as string) || '',
        tool_call_id: (obj.tool_call_id as string) || '',
        tool_name: (obj.tool_name as string) || '',
        output: (obj.output as string) || '',
        is_final: obj.is_final as boolean | undefined,
        sequence: obj.sequence as number | undefined,
      } as ToolOutputMessage;

    case 'error':
      return {
        type: StreamMessageType.ERROR,
        thread_id: (obj.thread_id as string) || '',
        error: obj.error as string | undefined,
        message: obj.message as string | undefined,
        sequence: obj.sequence as number | undefined,
      } as ErrorStreamMessage;

    case 'ping':
      return {
        type: StreamMessageType.PING,
        thread_id: (obj.thread_id as string) || '',
        sequence: obj.sequence as number | undefined,
      } as PingMessage;

    case 'llm_response_start':
      return {
        type: StreamMessageType.LLM_RESPONSE_START,
        thread_id: (obj.thread_id as string) || '',
        sequence: obj.sequence as number | undefined,
      } as LlmResponseStartMessage;

    default:
      return null;
  }
}

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

