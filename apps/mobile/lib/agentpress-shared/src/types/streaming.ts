export type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'completed' | 'stopped' | 'failed' | 'error';

export interface StreamingToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, any> | string;
  source: 'native' | 'xml';
  is_delta?: boolean;
  arguments_delta?: string;
  index?: number;
  completed?: boolean;
  tool_result?: any;
}

export interface StreamingMetadata {
  stream_status?: 'chunk' | 'complete' | 'tool_call_chunk';
  thread_run_id?: string;
  tool_calls?: StreamingToolCall[];
  [key: string]: any;
}

export interface AskCompleteContent {
  toolType: 'ask' | 'complete';
  text: string;
}
