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

  // Track reconnection state to suppress stale close/error events from old EventSource
  const isReconnectingRef = useRef<boolean>(false);
  const reconnectTimestampRef = useRef<number>(0);
  const RECONNECT_GRACE_PERIOD_MS = 3000; // Ignore close/error events for 3s after reconnect

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

  // Wrap onError to suppress errors during reconnection grace period
  const wrappedOnError = useCallback((error: string) => {
    const timeSinceReconnect = Date.now() - reconnectTimestampRef.current;

    // If we're in the grace period after a reconnect, suppress "stream closed unexpectedly" errors
    // These are likely from the OLD EventSource that died when app was backgrounded
    if (timeSinceReconnect < RECONNECT_GRACE_PERIOD_MS) {
      const isStaleCloseError =
        error.includes('Stream closed unexpectedly') ||
        error.includes('stream closed') ||
        error.includes('connection');

      if (isStaleCloseError) {
        log.log('[useAgentStream] Suppressing stale error during reconnect grace period:', error);
        return;
      }
    }

    log.log('[useAgentStream] onError:', error);
    callbacks.onError?.(error);
  }, [callbacks]);

  // Wrap onClose to suppress close events during reconnection grace period
  const wrappedOnClose = useCallback((finalStatus: string) => {
    const timeSinceReconnect = Date.now() - reconnectTimestampRef.current;

    // If we're in the grace period after a reconnect, check if this is a stale close
    if (timeSinceReconnect < RECONNECT_GRACE_PERIOD_MS && finalStatus === 'error') {
      log.log('[useAgentStream] Suppressing stale close event during reconnect grace period, status:', finalStatus);
      return;
    }

    log.log('[useAgentStream] onClose:', finalStatus);
    callbacks.onClose?.(finalStatus);
  }, [callbacks]);

  // Map callbacks to core callbacks with wrapped handlers
  const coreCallbacks: UseAgentStreamCoreCallbacks = {
    onMessage: wrappedOnMessage,
    onStatusChange: callbacks.onStatusChange,
    onError: wrappedOnError,
    onClose: wrappedOnClose,
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

    // Prevent multiple simultaneous reconnects
    if (isReconnectingRef.current) {
      log.log('[useAgentStream] forceReconnect: Already reconnecting, skipping');
      return { reconnected: false, agentStatus: null };
    }

    log.log('[useAgentStream] forceReconnect: Checking agent status for run:', runId);
    isReconnectingRef.current = true;
    reconnectTimestampRef.current = Date.now();

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
          isReconnectingRef.current = false;
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
        isReconnectingRef.current = false;
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

      // Give the new stream a grace period before allowing close events to be processed
      // This prevents stale close events from the old EventSource from triggering errors
      setTimeout(() => {
        isReconnectingRef.current = false;
        log.log('[useAgentStream] forceReconnect: Grace period ended, reconnect complete');
      }, 2000);

      return { reconnected: true, agentStatus: 'running' };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn('[useAgentStream] forceReconnect: Error checking/reconnecting:', errMsg);
      isReconnectingRef.current = false;

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

  // Auto-clear stale "stream closed unexpectedly" errors during reconnect grace period
  // This handles the race condition where the old EventSource fires a close event
  // after we've already reconnected with a new EventSource
  const suppressedErrorRef = useRef<boolean>(false);
  const isRestartingAfterStaleErrorRef = useRef<boolean>(false);

  // Check if we should suppress the error (stale close event during reconnect)
  const shouldSuppressError = useMemo(() => {
    if (!coreResult.error) return false;

    const timeSinceReconnect = Date.now() - reconnectTimestampRef.current;
    if (timeSinceReconnect > RECONNECT_GRACE_PERIOD_MS) return false;

    // Only suppress "stream closed unexpectedly" type errors during grace period
    const isStaleCloseError =
      coreResult.error.includes('Stream closed unexpectedly') ||
      coreResult.error.includes('stream closed') ||
      coreResult.error.toLowerCase().includes('connection');

    if (isStaleCloseError) {
      log.log('[useAgentStream] Suppressing stale error during grace period:', coreResult.error);

      // Clear the error and RESTART the stream
      // The finalizeStream in core hook killed the connection, we need to restart it
      if (!suppressedErrorRef.current && !isRestartingAfterStaleErrorRef.current) {
        suppressedErrorRef.current = true;
        isRestartingAfterStaleErrorRef.current = true;

        // Use setTimeout to avoid calling during render
        setTimeout(async () => {
          const runId = currentRunIdRef.current;
          log.log('[useAgentStream] Restarting stream after stale error, runId:', runId);

          // Clear the error first
          coreResult.clearError();
          suppressedErrorRef.current = false;

          // If we have a run ID, restart the stream
          if (runId) {
            try {
              // Check if agent is still running before restarting
              const token = await getAuthToken();
              const response = await fetch(`${API_URL}/agent-runs/${runId}/status`, {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {},
              });

              if (response.ok) {
                const statusData = await response.json();
                if (statusData.status === 'running') {
                  log.log('[useAgentStream] Agent still running, restarting stream...');
                  // Update timestamp to extend grace period for this new restart
                  reconnectTimestampRef.current = Date.now();
                  await coreResult.startStreaming(runId);
                  log.log('[useAgentStream] Stream restarted successfully after stale error');
                } else {
                  log.log('[useAgentStream] Agent no longer running:', statusData.status);
                  currentRunIdRef.current = null;
                }
              } else {
                log.log('[useAgentStream] Failed to check agent status:', response.status);
                currentRunIdRef.current = null;
              }
            } catch (err) {
              log.warn('[useAgentStream] Error restarting stream:', err);
              currentRunIdRef.current = null;
            }
          }

          isRestartingAfterStaleErrorRef.current = false;
        }, 0);
      }
      return true;
    }

    return false;
  }, [coreResult.error, coreResult.clearError, coreResult.startStreaming]);

  // Compute the actual error to return (null if suppressed)
  const effectiveError = shouldSuppressError ? null : coreResult.error;

  // Compute effective status (if error is suppressed, status should be 'streaming' or 'idle')
  const effectiveStatus = useMemo(() => {
    if (shouldSuppressError && coreResult.status === 'error') {
      // If we suppressed the error, the agent is probably still running
      // Use our own currentRunIdRef because coreResult.agentRunId gets cleared by finalizeStream
      // before we have a chance to check it
      const hasActiveRun = currentRunIdRef.current || coreResult.agentRunId;
      log.log('[useAgentStream] effectiveStatus: suppressing error, hasActiveRun:', !!hasActiveRun, 'currentRunIdRef:', currentRunIdRef.current, 'coreResult.agentRunId:', coreResult.agentRunId);
      return hasActiveRun ? 'streaming' : 'idle';
    }
    return coreResult.status;
  }, [shouldSuppressError, coreResult.status, coreResult.agentRunId]);

  // Log state changes for debugging mobile reconnection issues
  // TODO: Remove these logs after mobile streaming is stable
  if (coreResult.status !== effectiveStatus || coreResult.error !== effectiveError) {
    log.log('[useAgentStream] STATE OVERRIDE:', {
      coreStatus: coreResult.status,
      effectiveStatus,
      coreError: coreResult.error,
      effectiveError,
      coreAgentRunId: coreResult.agentRunId,
      currentRunIdRef: currentRunIdRef.current,
      shouldSuppressError,
      timeSinceReconnect: Date.now() - reconnectTimestampRef.current,
    });
  }

  // Keep our own run ID ref in sync, but don't clear it when core clears (that's the bug we're fixing)
  if (coreResult.agentRunId && coreResult.agentRunId !== currentRunIdRef.current) {
    log.log('[useAgentStream] Updating currentRunIdRef:', coreResult.agentRunId);
    currentRunIdRef.current = coreResult.agentRunId;
  }

  return {
    status: effectiveStatus,
    textContent: textContentString,
    reasoningContent: coreResult.reasoningContent,
    isReasoningComplete,
    toolCall: coreResult.toolCall,
    error: effectiveError,
    agentRunId: coreResult.agentRunId || currentRunIdRef.current, // Return our ref if core cleared it
    retryCount: coreResult.retryCount,
    startStreaming: coreResult.startStreaming,
    stopStreaming: coreResult.stopStreaming,
    resumeStream: coreResult.resumeStream,
    forceReconnect, // Mobile-specific: Always reconnect after app backgrounds
    clearError: coreResult.clearError,
    setError: coreResult.setError,
  };
}
