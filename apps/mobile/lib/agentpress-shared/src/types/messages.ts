export interface UnifiedMessage {
  message_id: string | null;
  thread_id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'status' | 'reasoning' | 'browser_state' | 'image_context' | 'llm_response_end' | 'llm_response_start';
  is_llm_message: boolean;
  content: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  agent_id?: string;
  sequence?: number;
  sandbox_id?: string;
  agents?: { name: string };
}

export interface ParsedContent {
  role?: 'user' | 'assistant' | 'tool' | 'system';
  content?: any;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  status_type?: string;
  function_name?: string;
  xml_tag_name?: string;
  arguments?: any;
  tool_index?: number;
  result?: any;
  is_error?: boolean;
  message?: string;
  reasoning_content?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  [key: string]: any;
}

export interface ParsedMetadata {
  stream_status?: 'chunk' | 'complete' | 'tool_call_chunk';
  thread_run_id?: string;
  llm_response_id?: string;
  tool_index?: number;
  assistant_message_id?: string;
  linked_tool_result_message_id?: string;
  tool_calls?: Array<{
    tool_call_id: string;
    function_name: string;
    arguments: Record<string, any> | string;
    source: 'native' | 'xml';
    is_delta?: boolean;
    arguments_delta?: string;
    index?: number;
    completed?: boolean;
    tool_result?: any;
  }>;
  text_content?: string;
  reasoning_content?: string;
  function_name?: string;
  result?: { success: boolean; output: any; error?: string | null };
  return_format?: 'native' | 'xml';
  tool_call_id?: string;
  [key: string]: any;
}

export interface MessageGroup {
  type: 'user' | 'assistant_group';
  messages: UnifiedMessage[];
  key: string;
}

export type AgentStatus = 'idle' | 'running' | 'connecting' | 'error';
