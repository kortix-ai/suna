/**
 * Tool Data Extractor
 * 
 * Extracts structured tool call and tool result data from UnifiedMessage objects
 * Matches the frontend implementation for consistency
 */

import type { UnifiedMessage, ParsedMetadata } from '@/api/types';
import { safeJsonParse } from './message-grouping';

/**
 * Structured tool call data from metadata
 */
export interface ToolCallData {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, any> | string; // Can be string during streaming (partial JSON)
  source: 'native' | 'xml';
}

/**
 * Structured tool result data from metadata
 */
export interface ToolResultData {
  success: boolean;
  output: any;
  error?: string | null;
}

/**
 * Extract tool call data from assistant message metadata
 * 
 * @param assistantMessage - The assistant message containing tool calls
 * @param toolCallId - Optional tool call ID to find specific tool call
 * @returns Tool call data or null if not found
 */
export function extractToolCall(
  assistantMessage: UnifiedMessage | null,
  toolCallId?: string
): ToolCallData | null {
  if (!assistantMessage) return null;
  
  const metadata = safeJsonParse<ParsedMetadata>(assistantMessage.metadata, {});
  const toolCalls = metadata.tool_calls || [];
  
  if (toolCalls.length === 0) return null;
  
  // If toolCallId provided, find specific tool call
  if (toolCallId) {
    const toolCall = toolCalls.find(tc => tc.tool_call_id === toolCallId);
    if (!toolCall || !toolCall.function_name) return null;
    
    // Parse arguments if string
    let args: Record<string, any> | string = toolCall.arguments || {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        // Keep as string if partial JSON
      }
    }
    
    return {
      tool_call_id: toolCall.tool_call_id || '',
      function_name: toolCall.function_name,
      arguments: args,
      source: toolCall.source || 'native',
    };
  }
  
  // Return first tool call if no ID specified
  if (toolCalls.length === 0) {
    return null;
  }
  
  const toolCall = toolCalls[0];
  if (!toolCall || !toolCall.function_name) {
    return null;
  }
  
  let args: Record<string, any> | string = toolCall.arguments || {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      // Keep as string if partial JSON
    }
  }
  
  return {
    tool_call_id: toolCall.tool_call_id || '',
    function_name: toolCall.function_name,
    arguments: args,
    source: toolCall.source || 'native',
  };
}

/**
 * Extract tool result data from tool message metadata
 * 
 * @param toolMessage - The tool message containing result
 * @returns Tool result data or null if not found
 */
export function extractToolResult(toolMessage: UnifiedMessage | null): ToolResultData | null {
  if (!toolMessage) return null;
  
  const metadata = safeJsonParse<ParsedMetadata>(toolMessage.metadata, {});
  const result = metadata.result;
  
  if (!result) return null;
  
  return {
    success: result.success !== undefined ? result.success : true,
    output: result.output !== undefined ? result.output : null,
    error: result.error || null,
  };
}

/**
 * Extract both tool call and tool result from message pair
 * 
 * @param assistantMessage - Assistant message with tool call
 * @param toolMessage - Tool message with result
 * @returns Object with toolCall and toolResult
 */
export function extractToolData(
  assistantMessage: UnifiedMessage | null,
  toolMessage: UnifiedMessage | null
): {
  toolCall: ToolCallData | null;
  toolResult: ToolResultData | null;
} {
  // First, try to get tool_call_id from tool message to find the specific tool call
  let toolCallId: string | undefined = undefined;
  if (toolMessage) {
    const toolMetadata = safeJsonParse<ParsedMetadata>(toolMessage.metadata, {});
    toolCallId = toolMetadata.tool_call_id;
  }
  
  // Extract tool call - if we have toolCallId, use it to find the specific tool call
  const toolCall = extractToolCall(assistantMessage, toolCallId);
  
  // Extract tool result
  let toolResult: ToolResultData | null = null;
  if (toolMessage) {
    toolResult = extractToolResult(toolMessage);
  }
  
  return { toolCall, toolResult };
}

/**
 * Extract tool call and result with additional metadata
 * Alias for extractToolData with extended return type
 */
export function extractToolCallAndResult(
  assistantMessage: UnifiedMessage | null,
  toolMessage: UnifiedMessage | null
): {
  toolCall: ToolCallData | null;
  toolResult: ToolResultData | null;
  isSuccess: boolean;
  assistantTimestamp?: string;
  toolTimestamp?: string;
} {
  const { toolCall, toolResult } = extractToolData(assistantMessage, toolMessage);
  
  return {
    toolCall,
    toolResult,
    isSuccess: toolResult?.success !== false,
    assistantTimestamp: assistantMessage?.created_at,
    toolTimestamp: toolMessage?.created_at,
  };
}

