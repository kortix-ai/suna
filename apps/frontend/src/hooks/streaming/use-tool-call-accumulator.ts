import { useRef, useCallback, useState } from 'react';
import {
  createAccumulatorState,
  clearAccumulator,
  accumulateToolCallDeltas,
  reconstructToolCalls,
  markToolCallCompleted,
  type ToolCallAccumulatorState,
  type UnifiedMessage,
  type ToolCallStreamMessage,
  type ToolOutputMessage,
} from '@agentpress/shared';

export interface UseToolCallAccumulatorResult {
  accumulator: ToolCallAccumulatorState;
  current: UnifiedMessage | null;
  setCurrent: (toolCall: UnifiedMessage | null) => void;
  reset: () => void;
  handleToolCallDelta: (message: ToolCallStreamMessage) => void;
  handleToolOutput: (message: ToolOutputMessage) => void;
}

export function useToolCallAccumulator(): UseToolCallAccumulatorResult {
  const accumulatorRef = useRef<ToolCallAccumulatorState>(createAccumulatorState());
  const [current, setCurrent] = useState<UnifiedMessage | null>(null);

  const reset = useCallback(() => {
    clearAccumulator(accumulatorRef.current);
    setCurrent(null);
  }, []);

  const handleToolCallDelta = useCallback((message: ToolCallStreamMessage) => {
    // Accumulate the tool call delta
    accumulateToolCallDeltas(
      [{
        tool_call_id: message.tool_call_id,
        function_name: message.function_name,
        arguments: (message.arguments as string) || '',
        arguments_delta: message.arguments_delta,
        is_delta: message.is_delta,
        index: message.index,
        source: 'native' as const,
      }],
      message.sequence ?? 0,
      accumulatorRef.current
    );
    
    // Reconstruct and update current
    const reconstructed = reconstructToolCalls(accumulatorRef.current);
    if (reconstructed.length > 0) {
      const latest = reconstructed[reconstructed.length - 1];
      const now = new Date().toISOString();
      setCurrent({
        message_id: `tool-call-${latest.tool_call_id}`,
        thread_id: message.thread_id,
        type: 'tool',
        is_llm_message: false,
        content: JSON.stringify({ arguments: latest.arguments }),
        metadata: JSON.stringify({
          tool_call_id: latest.tool_call_id,
          function_name: latest.function_name,
          is_delta: latest.is_delta,
          completed: latest.completed,
        }),
        created_at: now,
        updated_at: now,
      });
    }
  }, []);

  const handleToolOutput = useCallback((message: ToolOutputMessage) => {
    // Mark the tool call as completed with its result
    const now = new Date().toISOString();
    const resultMessage: UnifiedMessage = {
      message_id: `tool-result-${message.tool_call_id}`,
      thread_id: message.thread_id,
      type: 'tool',
      is_llm_message: false,
      content: JSON.stringify({ output: message.output }),
      metadata: JSON.stringify({
        tool_call_id: message.tool_call_id,
        tool_name: message.tool_name,
        is_final: message.is_final,
      }),
      created_at: now,
      updated_at: now,
    };
    markToolCallCompleted(
      message.tool_call_id,
      resultMessage,
      accumulatorRef.current
    );
    
    // Reconstruct and update current
    const reconstructed = reconstructToolCalls(accumulatorRef.current);
    if (reconstructed.length > 0) {
      const latest = reconstructed.find(tc => tc.tool_call_id === message.tool_call_id);
      if (latest) {
        setCurrent({
          message_id: `tool-call-${latest.tool_call_id}`,
          thread_id: message.thread_id,
          type: 'tool',
          is_llm_message: false,
          content: JSON.stringify({ arguments: latest.arguments, result: latest.tool_result }),
          metadata: JSON.stringify({
            tool_call_id: latest.tool_call_id,
            function_name: latest.function_name,
            is_delta: false,
            completed: true,
          }),
          created_at: now,
          updated_at: now,
        });
      }
    }
  }, []);

  return {
    accumulator: accumulatorRef.current,
    current,
    setCurrent,
    reset,
    handleToolCallDelta,
    handleToolOutput,
  };
}
