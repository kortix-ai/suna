import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import EventSource from 'react-native-sse';
import type { UnifiedMessage } from '@agentpress/shared';
import { API_URL, getAuthToken } from '@/api/config';
import { chatKeys } from '@/lib/chat';
import {
  type TextChunk,
  useAgentStreamCore,
  type StreamConfig,
  type UseAgentStreamCoreCallbacks,
} from '@agentpress/shared/streaming';

interface UseAgentStreamResult {
  status: string;
  textContent: string; // String for compatibility with existing components
  toolCall: UnifiedMessage | null;
  error: string | null;
  agentRunId: string | null;
  retryCount: number; // Number of reconnection attempts (0 = connected)
  startStreaming: (runId: string) => Promise<void>;
  stopStreaming: () => Promise<void>;
  resumeStream: () => Promise<void>; // Call when app comes back to foreground
  clearError: () => void; // Clear error state when switching threads
  setError: (error: string) => void; // Set error state (e.g., when retry fails)
}

interface AgentStreamCallbacks {
  onMessage: (message: UnifiedMessage) => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: string) => void;
  onClose?: (finalStatus: string) => void;
  onAssistantStart?: () => void;
  onAssistantChunk?: (chunk: { content: string }) => void;
  onToolCallChunk?: (message: UnifiedMessage) => void; // New callback for tool call chunks
}

export function useAgentStream(
  callbacks: AgentStreamCallbacks,
  threadId: string,
  setMessages: (messages: UnifiedMessage[]) => void,
  agentId?: string,
): UseAgentStreamResult {
  const queryClient = useQueryClient();

  // Build query keys array for invalidation
  const queryKeys: (string | readonly string[])[] = [
    ['active-agent-runs'],
    chatKeys.messages(threadId),
  ];

  if (agentId) {
    queryKeys.push(
      ['agents'],
      ['agent', agentId],
    );
  }

  // Create simplified config - core hook handles EventSource creation and API calls
  const config: StreamConfig = {
    apiUrl: API_URL,
    getAuthToken,
    createEventSource: (url: string) => new EventSource(url),
    queryKeys,
  };

  // Map callbacks to core callbacks
  const coreCallbacks: UseAgentStreamCoreCallbacks = {
    onMessage: callbacks.onMessage,
    onStatusChange: callbacks.onStatusChange,
    onError: callbacks.onError,
    onClose: callbacks.onClose,
    onAssistantStart: callbacks.onAssistantStart,
    onAssistantChunk: callbacks.onAssistantChunk,
    onToolCallChunk: callbacks.onToolCallChunk,
  };

  // Use the core hook
  const coreResult = useAgentStreamCore(
    config,
    coreCallbacks,
    threadId,
    setMessages,
    queryClient,
    { type: 'timeout', throttleMs: 16 } // Mobile uses timeout throttling
  );

  // Convert TextChunk[] to string for compatibility with existing components
  const textContentString = useMemo(() => {
    if (!coreResult.textContent || coreResult.textContent.length === 0) return '';
    return coreResult.textContent.map(chunk => chunk.content).join('');
  }, [coreResult.textContent]);

  return {
    status: coreResult.status,
    textContent: textContentString,
    toolCall: coreResult.toolCall,
    error: coreResult.error,
    agentRunId: coreResult.agentRunId,
    retryCount: coreResult.retryCount,
    startStreaming: coreResult.startStreaming,
    stopStreaming: coreResult.stopStreaming,
    resumeStream: coreResult.resumeStream,
    clearError: coreResult.clearError,
    setError: coreResult.setError,
  };
}
