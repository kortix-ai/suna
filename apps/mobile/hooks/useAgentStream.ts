import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useCallback, useRef } from 'react';
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
import { log } from '@/lib/logger';

// Message types that are metadata/UX only and should be silently ignored
// These come from the backend during streaming but are not part of the UnifiedMessage type
const METADATA_MESSAGE_TYPES = new Set([
  'thinking',
  'context_usage',
  'llm_ttft',
  'estimate',
  'ack',
  'prep_stage',
  'timing',
]);

interface UseAgentStreamResult {
  status: string;
  textContent: string; // String for compatibility with existing components
  reasoningContent: string; // Reasoning/thinking content from the model
  isReasoningComplete: boolean; // Whether reasoning generation is complete
  toolCall: UnifiedMessage | null;
  error: string | null;
  agentRunId: string | null;
  retryCount: number; // Number of reconnection attempts (0 = connected)
  startStreaming: (runId: string) => Promise<void>;
  stopStreaming: () => Promise<void>;
  resumeStream: () => Promise<void>; // Call when app comes back to foreground
  /**
   * Mobile-specific: Force reconnect after app comes back from background.
   * Unlike resumeStream, this ALWAYS reconnects because on mobile the EventSource
   * connection is killed when the app backgrounds.
   * Returns: { reconnected: boolean, agentStatus: string | null }
   */
  forceReconnect: () => Promise<{ reconnected: boolean; agentStatus: string | null }>;
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

  // Track the current run ID for forceReconnect
  const currentRunIdRef = useRef<string | null>(null);

  // Build query keys array for invalidation
  // CRITICAL: Don't include message query keys for optimistic threads - they don't exist on server
  const isOptimisticThread = threadId?.startsWith('optimistic-');
  const queryKeys: (string | readonly string[])[] = [
    ['active-agent-runs'],
  ];

  // Only add message query key for real threads
  if (threadId && !isOptimisticThread) {
    queryKeys.push(chatKeys.messages(threadId));
  }

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

  // Wrap onMessage to filter out metadata-only message types that cause warnings
  const wrappedOnMessage = useCallback((message: UnifiedMessage) => {
    // Check if this is a metadata-only message type (not in UnifiedMessage.type union)
    // These come during streaming but shouldn't trigger the onMessage callback
    const messageType = (message as any).type as string;
    if (METADATA_MESSAGE_TYPES.has(messageType)) {
      // Silently ignore metadata-only messages
      return;
    }
    callbacks.onMessage(message);
  }, [callbacks]);

  // Map callbacks to core callbacks with wrapped onMessage
  const coreCallbacks: UseAgentStreamCoreCallbacks = {
    onMessage: wrappedOnMessage,
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

  // Track the current run ID
  if (coreResult.agentRunId) {
    currentRunIdRef.current = coreResult.agentRunId;
  }

  // Convert TextChunk[] to string for compatibility with existing components
  const textContentString = useMemo(() => {
    if (!coreResult.textContent || coreResult.textContent.length === 0) return '';
    return coreResult.textContent.map(chunk => chunk.content).join('');
  }, [coreResult.textContent]);

  // Determine if reasoning is complete:
  // - When we transition from having reasoning to having text content
  // - Or when the stream status indicates completion
  const isReasoningComplete = useMemo(() => {
    const hasReasoning = coreResult.reasoningContent.length > 0;
    const hasText = textContentString.length > 0;
    const isNotStreaming = !['streaming', 'connecting'].includes(coreResult.status);

    // Reasoning is complete when:
    // 1. We have reasoning and now have text (model moved to response)
    // 2. Or stream ended with reasoning content
    return (hasReasoning && hasText) || (hasReasoning && isNotStreaming);
  }, [coreResult.reasoningContent, textContentString, coreResult.status]);

  /**
   * Mobile-specific force reconnect function.
   * On mobile, when the app backgrounds, the OS kills EventSource connections.
   * Unlike the shared resumeStream which tries to be smart about reconnecting,
   * this function ALWAYS checks server status and reconnects if agent is still running.
   *
   * CRITICAL: We do NOT call stopStreaming() here because that sends a POST to
   * /agent-runs/{runId}/stop which actually stops the agent on the server!
   * Instead, we call startStreaming() directly which handles cleanup of the old
   * EventSource internally without stopping the server-side agent.
   *
   * Returns:
   * - reconnected: true if we reconnected to a running stream
   * - agentStatus: the actual status from the server (null if we had no run to check)
   */
  const forceReconnect = useCallback(async (): Promise<{ reconnected: boolean; agentStatus: string | null }> => {
    const runId = currentRunIdRef.current || coreResult.agentRunId;

    if (!runId) {
      log.log('[useAgentStream] forceReconnect: No active run to reconnect');
      return { reconnected: false, agentStatus: null };
    }

    log.log('[useAgentStream] forceReconnect: Checking agent status for run:', runId);

    try {
      // Step 1: Check with server what the actual agent status is
      const token = await getAuthToken();
      const response = await fetch(`${API_URL}/agent-runs/${runId}/status`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        // 404 means agent run doesn't exist or already completed
        if (response.status === 404) {
          log.log('[useAgentStream] forceReconnect: Agent run not found (404), likely completed');
          return { reconnected: false, agentStatus: 'completed' };
        }
        throw new Error(`Failed to get agent status: ${response.status}`);
      }

      const statusData = await response.json();
      const agentStatus = statusData.status;

      log.log('[useAgentStream] forceReconnect: Server reports agent status:', agentStatus);

      if (agentStatus !== 'running') {
        // Agent is not running - no need to reconnect
        log.log('[useAgentStream] forceReconnect: Agent not running, skipping reconnect');
        return { reconnected: false, agentStatus };
      }

      // Step 2: Agent is still running - we MUST reconnect
      // The old EventSource connection is dead after backgrounding
      log.log('[useAgentStream] forceReconnect: Agent still running, reconnecting stream...');

      // IMPORTANT: Do NOT call stopStreaming() - that sends POST to /stop which kills the agent!
      // Just call startStreaming() directly - it handles cleanup of the old EventSource internally
      // (see startStreaming in use-agent-stream-core.ts lines 1031-1078 - it calls streamCleanupRef.current()
      // which only closes the EventSource locally, without sending any HTTP requests)
      await coreResult.startStreaming(runId);

      log.log('[useAgentStream] forceReconnect: Successfully reconnected to stream');
      return { reconnected: true, agentStatus: 'running' };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn('[useAgentStream] forceReconnect: Error checking/reconnecting:', errMsg);

      // Check if this is an expected "not found" error
      const isExpected =
        errMsg.includes('not found') ||
        errMsg.includes('404') ||
        errMsg.includes('does not exist') ||
        errMsg.includes('is not running');

      if (isExpected) {
        return { reconnected: false, agentStatus: 'completed' };
      }

      // Network error - can't determine status
      return { reconnected: false, agentStatus: null };
    }
  }, [coreResult.agentRunId, coreResult.startStreaming]);

  return {
    status: coreResult.status,
    textContent: textContentString,
    reasoningContent: coreResult.reasoningContent,
    isReasoningComplete,
    toolCall: coreResult.toolCall,
    error: coreResult.error,
    agentRunId: coreResult.agentRunId,
    retryCount: coreResult.retryCount,
    startStreaming: coreResult.startStreaming,
    stopStreaming: coreResult.stopStreaming,
    resumeStream: coreResult.resumeStream,
    forceReconnect, // Mobile-specific: Always reconnect after app backgrounds
    clearError: coreResult.clearError,
    setError: coreResult.setError,
  };
}
