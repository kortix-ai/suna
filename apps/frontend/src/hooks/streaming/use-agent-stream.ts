import { useState, useCallback } from 'react';
import { UnifiedMessage } from '@/components/thread/types';
import { useStreamConnection } from './use-stream-connection';
import { useStreamState } from './use-stream-state';
import { useStreamMessages, AgentStreamCallbacks } from './use-stream-messages';
import { useToolCallAccumulator } from './use-tool-call-accumulator';
import { stopAgent } from '@/lib/api/agents';

export interface UseAgentStreamResult {
  status: string;
  textContent: string;
  toolCall: UnifiedMessage | null;
  error: string | null;
  agentRunId: string | null;
  startStreaming: (runId: string) => Promise<void>;
  stopStreaming: () => Promise<void>;
}

export function useAgentStream(
  callbacks: AgentStreamCallbacks,
  threadId: string,
  setMessages: (messages: UnifiedMessage[]) => void,
  agentId?: string,
): UseAgentStreamResult {
  const state = useStreamState();
  const toolCalls = useToolCallAccumulator();
  const messages = useStreamMessages(callbacks, state, toolCalls);
  const connection = useStreamConnection(
    messages.handleMessage,
    messages.handleError,
    messages.handleClose,
  );
  
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  
  const startStreaming = useCallback(async (runId: string) => {
    state.reset();
    toolCalls.reset();
    setAgentRunId(runId);
    await connection.connect(runId);
  }, [state, toolCalls, connection]);
  
  const stopStreaming = useCallback(async () => {
    if (agentRunId) {
      connection.disconnect();
      try {
        await stopAgent(agentRunId);
      } catch (error) {
        console.error('Failed to stop agent:', error);
      }
    }
  }, [agentRunId, connection]);
  
  return {
    status: state.status,
    textContent: state.orderedContent,
    toolCall: toolCalls.current,
    error: state.error,
    agentRunId,
    startStreaming,
    stopStreaming,
  };
}
