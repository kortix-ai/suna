/**
 * Tool call delta accumulation utilities
 * Handles streaming tool call deltas and reconstructs complete tool calls
 */

import type { UnifiedMessage, ParsedMetadata, StreamingToolCall } from '../types';
import { safeJsonParse } from '../utils';

/**
 * Accumulated tool call structure for delta streaming
 */
export interface AccumulatedToolCall {
  metadata: {
    tool_call_id: string;
    function_name: string;
    index?: number;
    [key: string]: any;
  };
  chunks: Array<{ sequence: number; delta: string }>;
}

/**
 * Reconstructed tool call with merged arguments and completion status
 */
export interface ReconstructedToolCall {
  tool_call_id: string;
  function_name: string;
  index?: number;
  arguments: string;
  is_delta: boolean;
  completed: boolean;
  tool_result?: any;
}

/**
 * Accumulator state for managing tool call deltas
 */
export interface ToolCallAccumulatorState {
  accumulatedToolCalls: Map<string, AccumulatedToolCall>;
  completedToolCallIds: Set<string>;
  toolResults: Map<string, UnifiedMessage>;
}

/**
 * Create a new accumulator state
 */
export function createAccumulatorState(): ToolCallAccumulatorState {
  return {
    accumulatedToolCalls: new Map(),
    completedToolCallIds: new Set(),
    toolResults: new Map(),
  };
}

/**
 * Process tool call deltas from a streaming message chunk
 * Updates the accumulator with new deltas
 */
export function accumulateToolCallDeltas(
  toolCalls: StreamingToolCall[],
  sequence: number,
  accumulator: ToolCallAccumulatorState
): void {
  for (const tc of toolCalls) {
    const toolCallId = tc.tool_call_id || 'unknown';
    
    // Get or create the accumulated entry for this tool call
    let accumulated = accumulator.accumulatedToolCalls.get(toolCallId);
    if (!accumulated) {
      accumulated = {
        metadata: {
          tool_call_id: tc.tool_call_id,
          function_name: tc.function_name,
          index: tc.index,
        },
        chunks: [],
      };
      accumulator.accumulatedToolCalls.set(toolCallId, accumulated);
    }
    
    // Update metadata if we have newer info (function_name might come later)
    if (tc.function_name) {
      accumulated.metadata.function_name = tc.function_name;
    }
    if (tc.index !== undefined) {
      accumulated.metadata.index = tc.index;
    }
    
    if (tc.is_delta && tc.arguments_delta) {
      // This is a delta update - store it with sequence number
      const existingIndex = accumulated.chunks.findIndex(c => c.sequence === sequence);
      if (existingIndex >= 0) {
        accumulated.chunks[existingIndex].delta = tc.arguments_delta;
      } else {
        accumulated.chunks.push({ sequence, delta: tc.arguments_delta });
      }
      // Sort chunks by sequence number
      accumulated.chunks.sort((a, b) => a.sequence - b.sequence);
    } else if (tc.arguments) {
      // Full arguments (non-delta) - replace all chunks with single full argument
      const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
      accumulated.chunks = [{ sequence, delta: argsStr }];
    }
  }
}

/**
 * Reconstruct all tool calls from the accumulator
 * Merges streaming tool calls with completed tool results
 */
export function reconstructToolCalls(
  accumulator: ToolCallAccumulatorState
): ReconstructedToolCall[] {
  // Reconstruct accumulated tool calls
  const allReconstructedToolCalls = Array.from(accumulator.accumulatedToolCalls.values())
    .sort((a, b) => (a.metadata.index ?? 0) - (b.metadata.index ?? 0))
    .map(accumulated => {
      // Merge all chunks for this tool call
      let mergedArgs = '';
      for (const chunk of accumulated.chunks) {
        mergedArgs += chunk.delta;
      }
      
      const toolCallId = accumulated.metadata.tool_call_id;
      const isCompleted = accumulator.completedToolCallIds.has(toolCallId);
      const toolResult = accumulator.toolResults.get(toolCallId);
      
      return {
        tool_call_id: toolCallId,
        function_name: accumulated.metadata.function_name,
        index: accumulated.metadata.index,
        arguments: mergedArgs,
        is_delta: false, // Mark as assembled
        completed: isCompleted,
        tool_result: toolResult 
          ? safeJsonParse<ParsedMetadata>(toolResult.metadata, {}).result 
          : undefined,
      };
    });
  
  // Also include completed tools that may have results but aren't in accumulated ref
  // (edge case: result arrives before tool call is fully streamed)
  accumulator.toolResults.forEach((resultMessage, toolCallId) => {
    if (!accumulator.accumulatedToolCalls.has(toolCallId)) {
      const toolMetadata = safeJsonParse<ParsedMetadata>(resultMessage.metadata, {});
      const functionName = toolMetadata.function_name;
      if (functionName) {
        // Add to reconstructed calls if not already present
        const existing = allReconstructedToolCalls.find(tc => tc.tool_call_id === toolCallId);
        if (!existing) {
          allReconstructedToolCalls.push({
            tool_call_id: toolCallId,
            function_name: functionName,
            index: toolMetadata.index,
            arguments: '{}',
            is_delta: false,
            completed: true,
            tool_result: toolMetadata.result,
          });
        }
      }
    }
  });
  
  // Re-sort after adding any missing completed tools
  allReconstructedToolCalls.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  
  return allReconstructedToolCalls;
}

/**
 * Mark a tool call as completed and store its result
 */
export function markToolCallCompleted(
  toolCallId: string,
  resultMessage: UnifiedMessage,
  accumulator: ToolCallAccumulatorState
): void {
  accumulator.completedToolCallIds.add(toolCallId);
  accumulator.toolResults.set(toolCallId, resultMessage);
}

/**
 * Clear all accumulator state
 */
export function clearAccumulator(accumulator: ToolCallAccumulatorState): void {
  accumulator.accumulatedToolCalls.clear();
  accumulator.completedToolCallIds.clear();
  accumulator.toolResults.clear();
}

