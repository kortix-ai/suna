import type { UnifiedMessage } from '@/components/thread/types';
export type { UnifiedMessage };

export type ConnectionState = 
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'streaming'
  | 'reconnecting'
  | 'closed'
  | 'error';

export type AgentStatus = 
  | 'idle'
  | 'connecting'
  | 'running'
  | 'streaming'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'error';

export interface StreamMessage {
  type: 'assistant' | 'tool' | 'status' | 'user' | 'system' | 'ping' | 'tool_output_stream' | 'llm_response_start' | 'llm_response_end' | 'browser_state' | 'image_context';
  message_id?: string;
  thread_id?: string;
  content?: string;
  metadata?: string;
  sequence?: number;
  created_at?: string;
  updated_at?: string;
  is_llm_message?: boolean;
  agent_id?: string;
  agents?: { name?: string };
}

export interface ParsedContent {
  content?: string;
  role?: string;
  status_type?: string;
  message?: string;
  reasoning_content?: string;
  [key: string]: unknown;
}

export interface ParsedMetadata {
  stream_status?: 'chunk' | 'tool_call_chunk' | 'complete';
  tool_calls?: StreamingToolCall[];
  tool_call_id?: string;
  function_name?: string;
  result?: unknown;
  reasoning_content?: string;
  assistant_message_id?: string;
  index?: number;
  [key: string]: unknown;
}

export interface StreamingToolCall {
  tool_call_id: string;
  function_name: string;
  index?: number;
  is_delta?: boolean;
  arguments?: string | Record<string, unknown>;
  arguments_delta?: string;
}

export interface AccumulatedToolCall {
  metadata: {
    tool_call_id: string;
    function_name: string;
    index?: number;
  };
  chunks: Array<{ sequence: number; delta: string }>;
}

export interface ReconstructedToolCall {
  tool_call_id: string;
  function_name: string;
  index?: number;
  arguments: string;
  rawArguments?: string;
  is_delta: boolean;
  completed: boolean;
  tool_result?: unknown;
}

export interface ToolCallAccumulatorState {
  accumulatedToolCalls: Map<string, AccumulatedToolCall>;
  completedToolCallIds: Set<string>;
  toolResults: Map<string, StreamMessage>;
}

export interface ToolOutputStreamData {
  tool_call_id: string;
  tool_name: string;
  output: string;
  is_final: boolean;
}

export interface StreamConnectionConfig {
  apiUrl: string;
  getAuthToken: () => Promise<string | null>;
  onMessage: (data: string) => void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  onStateChange?: (state: ConnectionState) => void;
}

export interface StreamConnectionEvents {
  message: (data: string) => void;
  open: () => void;
  error: (error: Error) => void;
  close: () => void;
  stateChange: (state: ConnectionState) => void;
}

export interface UseAgentStreamConfig {
  threadId: string;
  agentId?: string;
  onMessage: (message: UnifiedMessage) => void;
  onStatusChange?: (status: AgentStatus) => void;
  onError?: (error: string) => void;
  onClose?: (finalStatus: string) => void;
  onAssistantStart?: () => void;
  onAssistantChunk?: (chunk: { content: string }) => void;
  onToolCallChunk?: (message: UnifiedMessage) => void;
  onToolOutputStream?: (data: ToolOutputStreamData) => void;
}

export interface UseAgentStreamResult {
  status: AgentStatus;
  textContent: string;
  reasoningContent: string;
  toolCall: UnifiedMessage | null;
  error: string | null;
  agentRunId: string | null;
  startStreaming: (runId: string) => Promise<void>;
  stopStreaming: () => Promise<void>;
}


export interface BillingErrorContext {
  errorMessage: string;
  balance?: string | null;
  isCreditsExhausted: boolean;
}

export type StreamEventType = 
  | 'text_chunk'
  | 'reasoning_chunk'
  | 'tool_call_start'
  | 'tool_call_chunk'
  | 'tool_call_complete'
  | 'tool_result'
  | 'status_update'
  | 'error'
  | 'ping';

export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
  sequence?: number;
  timestamp: number;
}
