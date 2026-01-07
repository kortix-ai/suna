/**
 * Stream message parsing and handling utilities
 * Platform-agnostic message processing for streaming
 */

import type { UnifiedMessage, ParsedContent, ParsedMetadata } from '../types';
import { safeJsonParse } from '../utils';
import type { ToolCallAccumulatorState, ReconstructedToolCall } from './tool-accumulator';
import { accumulateToolCallDeltas, reconstructToolCalls, markToolCallCompleted } from './tool-accumulator';

/**
 * Map backend agent status to frontend status string
 */
export function mapAgentStatus(backendStatus: string): string {
  switch (backendStatus) {
    case 'completed':
      return 'completed';
    case 'stopped':
      return 'stopped';
    case 'failed':
      return 'failed';
    default:
      return 'error';
  }
}

/**
 * Preprocess raw stream data (remove 'data: ' prefix if present)
 */
export function preprocessStreamData(rawData: string): string {
  let processedData = rawData;
  if (processedData.startsWith('data: ')) {
    processedData = processedData.substring(6).trim();
  }
  return processedData;
}

/**
 * Check if a message indicates stream completion
 */
export function isCompletionMessage(processedData: string): boolean {
  return (
    (processedData.includes('"type": "status"') &&
      processedData.includes('"status": "completed"')) ||
    processedData.includes('Run data not available for streaming') ||
    processedData.includes('Stream ended with status: completed') ||
    processedData === '{"type": "status", "status": "completed", "message": "Worker run completed successfully"}'
  );
}

/**
 * Parse a streaming message from raw data
 */
export function parseStreamingMessage(
  processedData: string
): UnifiedMessage | null {
  if (!processedData) return null;

  const message = safeJsonParse(processedData, null) as UnifiedMessage | null;
  if (!message) {
    return null;
  }

  return message;
}

/**
 * Handle assistant chunk message
 * Returns the content string if it's a text chunk
 */
export function handleAssistantChunk(
  message: UnifiedMessage,
  parsedContent: ParsedContent,
  parsedMetadata: ParsedMetadata
): string | null {
  if (
    parsedMetadata.stream_status === 'chunk' &&
    parsedContent.content
  ) {
    return typeof parsedContent.content === 'string'
      ? parsedContent.content
      : String(parsedContent.content);
  }
  return null;
}

/**
 * Extract reasoning content from streaming message
 * Returns reasoning content string if present
 */
export function extractReasoningContent(
  parsedContent: ParsedContent,
  parsedMetadata: ParsedMetadata
): string | null {
  // Check metadata first (where backend might put it)
  if (parsedMetadata.reasoning_content) {
    return typeof parsedMetadata.reasoning_content === 'string'
      ? parsedMetadata.reasoning_content
      : String(parsedMetadata.reasoning_content);
  }
  
  // Check content as fallback
  if (parsedContent.reasoning_content) {
    return typeof parsedContent.reasoning_content === 'string'
      ? parsedContent.reasoning_content
      : String(parsedContent.reasoning_content);
  }
  
  return null;
}

/**
 * Handle tool call chunk message
 * Updates accumulator and returns reconstructed tool calls
 */
export function handleToolCallChunk(
  message: UnifiedMessage,
  parsedMetadata: ParsedMetadata,
  accumulator: ToolCallAccumulatorState
): ReconstructedToolCall[] | null {
  if (parsedMetadata.stream_status !== 'tool_call_chunk') {
    return null;
  }

  const toolCalls = parsedMetadata.tool_calls || [];
  if (toolCalls.length === 0) {
    return null;
  }

  // Accumulate deltas from this chunk
  accumulateToolCallDeltas(toolCalls, message.sequence ?? 0, accumulator);

  // Reconstruct all tool calls
  return reconstructToolCalls(accumulator);
}

/**
 * Handle tool result message
 * Marks tool as completed and returns updated reconstructed tool calls
 */
export function handleToolResult(
  message: UnifiedMessage,
  parsedMetadata: ParsedMetadata,
  accumulator: ToolCallAccumulatorState
): ReconstructedToolCall[] | null {
  const toolCallId = parsedMetadata.tool_call_id;
  const functionName = parsedMetadata.function_name;

  if (!toolCallId || !functionName) {
    return null;
  }

  // Mark as completed and store result
  markToolCallCompleted(toolCallId, message, accumulator);

  // Reconstruct all tool calls with updated completion status
  return reconstructToolCalls(accumulator);
}

/**
 * Create updated message with reconstructed tool calls
 */
export function createMessageWithToolCalls(
  originalMessage: UnifiedMessage,
  parsedMetadata: ParsedMetadata,
  reconstructedToolCalls: ReconstructedToolCall[]
): UnifiedMessage {
  return {
    ...originalMessage,
    metadata: JSON.stringify({
      ...parsedMetadata,
      tool_calls: reconstructedToolCalls,
    }),
  };
}

