import type {
  StreamMessage,
  ParsedContent,
  ParsedMetadata,
  ReconstructedToolCall,
  ToolCallAccumulatorState,
  ToolOutputStreamData,
} from './types';
import type { UnifiedMessage } from '@/components/thread/types';
import { 
  safeJsonParse, 
  preprocessStreamData, 
  isCompletionMessage, 
  isBillingError 
} from './utils';
import {
  accumulateToolCallDeltas,
  reconstructToolCalls,
  markToolCallCompleted,
} from './tool-accumulator';

export interface ProcessedMessage {
  type: 'text_chunk' | 'reasoning_chunk' | 'tool_call_chunk' | 'tool_result' | 'message_complete' | 'status' | 'error' | 'billing_error' | 'ping' | 'tool_output_stream' | 'ignore';
  content?: string;
  message?: StreamMessage;
  toolCalls?: ReconstructedToolCall[];
  status?: string;
  errorMessage?: string;
  toolOutputStream?: ToolOutputStreamData;
}

export function parseStreamMessage(rawData: string): StreamMessage | null {
  const processedData = preprocessStreamData(rawData);
  if (!processedData || processedData.trim() === '') {
    return null;
  }
  
  try {
    return JSON.parse(processedData) as StreamMessage;
  } catch {
    return null;
  }
}

export function processStreamData(
  rawData: string,
  accumulator: ToolCallAccumulatorState
): ProcessedMessage {
  const processedData = preprocessStreamData(rawData);
  
  if (!processedData || processedData.trim() === '') {
    return { type: 'ignore' };
  }
  
  if (isCompletionMessage(processedData)) {
    return { type: 'status', status: 'completed' };
  }
  
  let jsonData: Record<string, unknown>;
  try {
    jsonData = JSON.parse(processedData);
  } catch {
    return { type: 'ignore' };
  }
  
  if (jsonData.status === 'error') {
    const errorMessage = (jsonData.message as string) || 'Unknown error occurred';
    if (isBillingError(errorMessage)) {
      return { type: 'billing_error', errorMessage };
    }
    return { type: 'error', errorMessage };
  }
  
  if (jsonData.type === 'status') {
    const status = jsonData.status as string;
    if (status === 'stopped') {
      const message = jsonData.message as string | undefined;
      if (message && isBillingError(message)) {
        return { type: 'billing_error', errorMessage: message };
      }
      return { type: 'status', status: 'stopped' };
    }
    if (status === 'completed') {
      return { type: 'status', status: 'completed' };
    }
  }
  
  if (jsonData.type === 'tool_output_stream') {
    return {
      type: 'tool_output_stream',
      toolOutputStream: {
        tool_call_id: jsonData.tool_call_id as string,
        tool_name: jsonData.tool_name as string,
        output: jsonData.output as string,
        is_final: jsonData.is_final as boolean,
      },
    };
  }
  
  if (jsonData.type === 'ping' && !jsonData.content) {
    return { type: 'ping' };
  }
  
  const message = jsonData as unknown as StreamMessage;
  if (!message.type) {
    return { type: 'ignore' };
  }
  
  return processTypedMessage(message, accumulator);
}

function processTypedMessage(
  message: StreamMessage,
  accumulator: ToolCallAccumulatorState
): ProcessedMessage {
  const parsedContent = safeJsonParse<ParsedContent>(message.content || '', {});
  const parsedMetadata = safeJsonParse<ParsedMetadata>(message.metadata || '', {});
  
  switch (message.type) {
    case 'assistant':
      return processAssistantMessage(message, parsedContent, parsedMetadata, accumulator);
    
    case 'tool':
      return processToolMessage(message, parsedMetadata, accumulator);
    
    case 'status':
      return processStatusMessage(parsedContent);
    
    case 'llm_response_start':
    case 'llm_response_end':
      return { type: 'ignore' };
    
    case 'user':
    case 'system':
      return { type: 'ignore', message };
    
    default:
      return { type: 'ignore' };
  }
}

function processAssistantMessage(
  message: StreamMessage,
  parsedContent: ParsedContent,
  parsedMetadata: ParsedMetadata,
  accumulator: ToolCallAccumulatorState
): ProcessedMessage {
  if (parsedMetadata.stream_status === 'tool_call_chunk') {
    const toolCalls = parsedMetadata.tool_calls || [];
    if (toolCalls.length > 0) {
      accumulateToolCallDeltas(toolCalls, message.sequence ?? 0, accumulator);
      const reconstructed = reconstructToolCalls(accumulator);
      
      const reasoningContent = extractReasoningContent(parsedContent, parsedMetadata);
      return { 
        type: 'tool_call_chunk', 
        toolCalls: reconstructed, 
        message,
        content: reasoningContent || undefined,
      };
    }
    return { type: 'ignore' };
  }
  
  const reasoningContent = extractReasoningContent(parsedContent, parsedMetadata);
  if (reasoningContent) {
    return { type: 'reasoning_chunk', content: reasoningContent, message };
  }
  
  if (parsedMetadata.stream_status === 'chunk' && parsedContent.content) {
    const content = typeof parsedContent.content === 'string' 
      ? parsedContent.content 
      : String(parsedContent.content);
    return { type: 'text_chunk', content, message };
  }
  
  if (parsedMetadata.stream_status === 'complete') {
    return { type: 'message_complete', message };
  }
  
  if (!parsedMetadata.stream_status && message.message_id) {
    return { type: 'text_chunk', content: '', message };
  }
  
  return { type: 'ignore' };
}

function processToolMessage(
  message: StreamMessage,
  parsedMetadata: ParsedMetadata,
  accumulator: ToolCallAccumulatorState
): ProcessedMessage {
  const toolCallId = parsedMetadata.tool_call_id;
  const functionName = parsedMetadata.function_name;
  
  if (toolCallId && functionName) {
    markToolCallCompleted(toolCallId, message, accumulator);
    const reconstructed = reconstructToolCalls(accumulator);
    return { type: 'tool_result', toolCalls: reconstructed, message };
  }
  
  return { type: 'ignore', message };
}

function processStatusMessage(parsedContent: ParsedContent): ProcessedMessage {
  switch (parsedContent.status_type) {
    case 'error':
      return { 
        type: 'error', 
        errorMessage: parsedContent.message || 'Worker run failed' 
      };
    case 'finish':
    case 'tool_completed':
    case 'tool_failed':
    case 'tool_error':
    case 'thread_run_start':
      return { type: 'ignore' };
    default:
      return { type: 'ignore' };
  }
}

function extractReasoningContent(
  parsedContent: ParsedContent,
  parsedMetadata: ParsedMetadata
): string | null {
  if (parsedMetadata.reasoning_content) {
    return typeof parsedMetadata.reasoning_content === 'string'
      ? parsedMetadata.reasoning_content
      : String(parsedMetadata.reasoning_content);
  }
  
  if (parsedContent.reasoning_content) {
    return typeof parsedContent.reasoning_content === 'string'
      ? parsedContent.reasoning_content
      : String(parsedContent.reasoning_content);
  }
  
  return null;
}

export function createMessageWithToolCalls(
  originalMessage: StreamMessage,
  reconstructedToolCalls: ReconstructedToolCall[]
): UnifiedMessage {
  const parsedMetadata = safeJsonParse<ParsedMetadata>(originalMessage.metadata || '', {});
  
  return {
    message_id: originalMessage.message_id || '',
    thread_id: originalMessage.thread_id || '',
    type: originalMessage.type as UnifiedMessage['type'],
    content: originalMessage.content || '',
    metadata: JSON.stringify({
      ...parsedMetadata,
      tool_calls: reconstructedToolCalls,
    }),
    sequence: originalMessage.sequence,
    created_at: originalMessage.created_at || new Date().toISOString(),
    updated_at: originalMessage.updated_at || new Date().toISOString(),
    is_llm_message: originalMessage.is_llm_message ?? true,
    agent_id: originalMessage.agent_id,
    agents: originalMessage.agents?.name ? { name: originalMessage.agents.name } : undefined,
  };
}

export function streamMessageToUnifiedMessage(message: StreamMessage): UnifiedMessage {
  return {
    message_id: message.message_id || '',
    thread_id: message.thread_id || '',
    type: message.type as UnifiedMessage['type'],
    content: message.content || '',
    metadata: message.metadata || '',
    sequence: message.sequence,
    created_at: message.created_at || new Date().toISOString(),
    updated_at: message.updated_at || new Date().toISOString(),
    is_llm_message: message.is_llm_message ?? true,
    agent_id: message.agent_id,
    agents: message.agents?.name ? { name: message.agents.name } : undefined,
  };
}
