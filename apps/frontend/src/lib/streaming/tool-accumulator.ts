import type {
  StreamingToolCall,
  ReconstructedToolCall,
  ToolCallAccumulatorState,
  StreamMessage,
  ParsedMetadata,
} from './types';
import { safeJsonParse } from './utils';

export function createAccumulatorState(): ToolCallAccumulatorState {
  return {
    accumulatedToolCalls: new Map(),
    completedToolCallIds: new Set(),
    toolResults: new Map(),
  };
}

export function accumulateToolCallDeltas(
  toolCalls: StreamingToolCall[],
  sequence: number,
  accumulator: ToolCallAccumulatorState
): void {
  for (const tc of toolCalls) {
    const toolCallId = tc.tool_call_id || 'unknown';
    
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
    
    if (tc.function_name) {
      accumulated.metadata.function_name = tc.function_name;
    }
    if (tc.index !== undefined) {
      accumulated.metadata.index = tc.index;
    }
    
    if (tc.is_delta && tc.arguments_delta) {
      const existingIndex = accumulated.chunks.findIndex(c => c.sequence === sequence);
      if (existingIndex >= 0) {
        accumulated.chunks[existingIndex].delta = tc.arguments_delta;
      } else {
        accumulated.chunks.push({ sequence, delta: tc.arguments_delta });
      }
      accumulated.chunks.sort((a, b) => a.sequence - b.sequence);
    } else if (tc.arguments) {
      const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
      accumulated.chunks = [{ sequence, delta: argsStr }];
    }
  }
}

export function reconstructToolCalls(
  accumulator: ToolCallAccumulatorState
): ReconstructedToolCall[] {
  const allReconstructedToolCalls = Array.from(accumulator.accumulatedToolCalls.values())
    .sort((a, b) => (a.metadata.index ?? 0) - (b.metadata.index ?? 0))
    .map(accumulated => {
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
        rawArguments: mergedArgs,
        is_delta: false,
        completed: isCompleted,
        tool_result: toolResult 
          ? safeJsonParse<ParsedMetadata>(toolResult.metadata || '', {}).result 
          : undefined,
      };
    });
  
  accumulator.toolResults.forEach((resultMessage, toolCallId) => {
    if (!accumulator.accumulatedToolCalls.has(toolCallId)) {
      const toolMetadata = safeJsonParse<ParsedMetadata>(resultMessage.metadata || '', {});
      const functionName = toolMetadata.function_name;
      if (functionName) {
        const existing = allReconstructedToolCalls.find(tc => tc.tool_call_id === toolCallId);
        if (!existing) {
          allReconstructedToolCalls.push({
            tool_call_id: toolCallId,
            function_name: functionName,
            index: toolMetadata.index,
            arguments: '{}',
            rawArguments: '{}',
            is_delta: false,
            completed: true,
            tool_result: toolMetadata.result,
          });
        }
      }
    }
  });
  
  allReconstructedToolCalls.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  
  return allReconstructedToolCalls;
}

export function markToolCallCompleted(
  toolCallId: string,
  resultMessage: StreamMessage,
  accumulator: ToolCallAccumulatorState
): void {
  accumulator.completedToolCallIds.add(toolCallId);
  accumulator.toolResults.set(toolCallId, resultMessage);
}

export function clearAccumulator(accumulator: ToolCallAccumulatorState): void {
  accumulator.accumulatedToolCalls.clear();
  accumulator.completedToolCallIds.clear();
  accumulator.toolResults.clear();
}

export function getAccumulatedArgumentsForToolCall(
  toolCallId: string,
  accumulator: ToolCallAccumulatorState
): string | null {
  const accumulated = accumulator.accumulatedToolCalls.get(toolCallId);
  if (!accumulated) return null;
  
  let mergedArgs = '';
  for (const chunk of accumulated.chunks) {
    mergedArgs += chunk.delta;
  }
  return mergedArgs;
}

export function hasToolCall(
  toolCallId: string,
  accumulator: ToolCallAccumulatorState
): boolean {
  return accumulator.accumulatedToolCalls.has(toolCallId);
}

export function isToolCallCompleted(
  toolCallId: string,
  accumulator: ToolCallAccumulatorState
): boolean {
  return accumulator.completedToolCallIds.has(toolCallId);
}
