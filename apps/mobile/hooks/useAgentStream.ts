import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import EventSource from 'react-native-sse';
import type { UnifiedMessage } from '@agentpress/shared';
import { API_URL, getAuthToken } from '@/api/config';
import { chatKeys } from '@/lib/chat';
import {
  useAgentStreamCore,
  type StreamConfig,
  type UseAgentStreamCoreCallbacks,
} from '@agentpress/shared/streaming';
import { log } from '@/lib/logger';

// Message types that are metadata/UX only and should be silently ignored
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
  textContent: string;
  reasoningContent: string;
  isReasoningComplete: boolean;
  toolCall: UnifiedMessage | null;
  error: string | null;
  agentRunId: string | null;
  retryCount: number;
  startStreaming: (runId: string) => Promise<void>;
  stopStreaming: () => Promise<void>;
  disconnectStream: () => void;
  resumeStream: () => Promise<void>;
  forceReconnect: () => Promise<{ reconnected: boolean; agentStatus: string | null }>;
  clearError: () => void;
  setError: (error: string) => void;
}

interface AgentStreamCallbacks {
  onMessage: (message: UnifiedMessage) => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: string) => void;
  onClose?: (finalStatus: string) => void;
  onAssistantStart?: () => void;
  onAssistantChunk?: (chunk: { content: string }) => void;
  onToolCallChunk?: (message: UnifiedMessage) => void;
}

// Reconnection states - explicit state machine, no timeouts
type ReconnectState =
  | 'idle'           // Not reconnecting
  | 'checking'       // Checking server status
  | 'reconnecting'   // Calling resumeStream
  | 'waiting'        // Waiting for stream to become active
  | 'done';          // Reconnect complete (transitions to idle)

export function useAgentStream(
  callbacks: AgentStreamCallbacks,
  threadId: string,
  setMessages: (messages: UnifiedMessage[]) => void,
  agentId?: string,
): UseAgentStreamResult {
  const queryClient = useQueryClient();

  // Track current run ID - we own this, core can clear its copy
  const currentRunIdRef = useRef<string | null>(null);

  // Track previous status to avoid logging duplicate status changes
  const prevStatusRef = useRef<string | null>(null);

  // Reconnection state machine - no timeouts, just explicit states
  const [reconnectState, setReconnectState] = useState<ReconnectState>('idle');
  const reconnectRunIdRef = useRef<string | null>(null); // The run ID we're reconnecting to

  // Build query keys
  const isOptimisticThread = threadId?.startsWith('optimistic-');
  const queryKeys: (string | readonly string[])[] = [['active-agent-runs']];
  if (threadId && !isOptimisticThread) {
    queryKeys.push(chatKeys.messages(threadId));
  }
  if (agentId) {
    queryKeys.push(['agents'], ['agent', agentId]);
  }

  const config: StreamConfig = {
    apiUrl: API_URL,
    getAuthToken,
    createEventSource: (url: string) => new EventSource(url),
    queryKeys,
  };

  // Wrap callbacks to filter during reconnection
  const wrappedOnMessage = useCallback((message: UnifiedMessage) => {
    const messageType = (message as any).type as string;
    if (METADATA_MESSAGE_TYPES.has(messageType)) return;
    callbacks.onMessage(message);
  }, [callbacks]);

  // During reconnection, suppress stale errors from dead EventSource
  const wrappedOnError = useCallback((error: string) => {
    if (reconnectState !== 'idle') {
      const isStaleError =
        error.includes('Stream closed unexpectedly') ||
        error.includes('stream closed') ||
        error.toLowerCase().includes('connection');
      if (isStaleError) {
        log.log('[useAgentStream] Suppressing stale error during reconnect:', error);
        return;
      }
    }
    callbacks.onError?.(error);
  }, [callbacks, reconnectState]);

  // During reconnection, suppress stale close events
  const wrappedOnClose = useCallback((finalStatus: string) => {
    if (reconnectState !== 'idle' && finalStatus === 'error') {
      log.log('[useAgentStream] Suppressing stale close during reconnect');
      return;
    }
    callbacks.onClose?.(finalStatus);
  }, [callbacks, reconnectState]);

  // Wrap status change to add logging - only log actual changes, not duplicates
  const wrappedOnStatusChange = useCallback((newStatus: string) => {
    if (newStatus !== prevStatusRef.current) {
      log.log('[useAgentStream] Status:', newStatus, reconnectState !== 'idle' ? `(reconnect: ${reconnectState})` : '');
      prevStatusRef.current = newStatus;
    }
    callbacks.onStatusChange?.(newStatus);
  }, [callbacks, reconnectState]);

  const coreCallbacks: UseAgentStreamCoreCallbacks = {
    onMessage: wrappedOnMessage,
    onStatusChange: wrappedOnStatusChange,
    onError: wrappedOnError,
    onClose: wrappedOnClose,
    onAssistantStart: callbacks.onAssistantStart,
    onAssistantChunk: callbacks.onAssistantChunk,
    onToolCallChunk: callbacks.onToolCallChunk,
  };

  const coreResult = useAgentStreamCore(
    config,
    coreCallbacks,
    threadId,
    setMessages,
    queryClient,
    { type: 'timeout', throttleMs: 16 }
  );

  // Keep our run ID ref in sync (but don't clear when core clears)
  if (coreResult.agentRunId && coreResult.agentRunId !== currentRunIdRef.current) {
    log.log('[useAgentStream] Tracking run ID:', coreResult.agentRunId);
    currentRunIdRef.current = coreResult.agentRunId;
  }

  // State machine transitions based on core status
  useEffect(() => {
    if (reconnectState === 'waiting') {
      // We're waiting for stream to become active after reconnect
      if (coreResult.status === 'streaming') {
        log.log('[useAgentStream] Reconnect complete - stream is active');
        setReconnectState('done');
      } else if (['completed', 'stopped', 'agent_not_running'].includes(coreResult.status)) {
        log.log('[useAgentStream] Agent finished during reconnect');
        setReconnectState('done');
      }
    }

    // Transition from 'done' to 'idle' immediately
    if (reconnectState === 'done') {
      setReconnectState('idle');
      reconnectRunIdRef.current = null;
    }
  }, [reconnectState, coreResult.status]);

  // Convert text content
  const textContentString = useMemo(() => {
    if (!coreResult.textContent || coreResult.textContent.length === 0) return '';
    return coreResult.textContent.map(chunk => chunk.content).join('');
  }, [coreResult.textContent]);

  // Determine if reasoning is complete:
  // - When we transition from having reasoning to having text content
  // - Or when the model moves to tool calls (reasoning→tool path)
  // - Or when the stream status indicates completion
  const isReasoningComplete = useMemo(() => {
    const hasReasoning = coreResult.reasoningContent.length > 0;
    const hasText = textContentString.length > 0;
    const hasToolCall = coreResult.toolCall !== null;
    const isNotStreaming = !['streaming', 'connecting'].includes(coreResult.status);

    // Reasoning is complete when:
    // 1. We have reasoning and now have text (model moved to response)
    // 2. We have reasoning and now have a tool call (model skipped text, went to tools)
    // 3. Or stream ended with reasoning content
    return (hasReasoning && hasText) || (hasReasoning && hasToolCall) || (hasReasoning && isNotStreaming);
  }, [coreResult.reasoningContent, textContentString, coreResult.toolCall, coreResult.status]);

  /**
   * Force reconnect when app comes back from background.
   * Uses explicit state machine - no timeouts.
   */
  const forceReconnect = useCallback(async (): Promise<{ reconnected: boolean; agentStatus: string | null }> => {
    const runId = currentRunIdRef.current || coreResult.agentRunId;

    if (!runId) {
      log.log('[useAgentStream] forceReconnect: No run to reconnect');
      return { reconnected: false, agentStatus: null };
    }

    if (reconnectState !== 'idle') {
      log.log('[useAgentStream] forceReconnect: Already in progress, state:', reconnectState);
      return { reconnected: false, agentStatus: null };
    }

    log.log('[useAgentStream] forceReconnect: Starting for run:', runId);
    reconnectRunIdRef.current = runId;
    setReconnectState('checking');

    try {
      // Step 1: Check server status
      const token = await getAuthToken();
      const response = await fetch(`${API_URL}/agent-runs/${runId}/status`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        if (response.status === 404) {
          log.log('[useAgentStream] forceReconnect: Agent not found (404)');
          setReconnectState('idle');
          reconnectRunIdRef.current = null;
          return { reconnected: false, agentStatus: 'completed' };
        }
        throw new Error(`Status check failed: ${response.status}`);
      }

      const statusData = await response.json();
      const agentStatus = statusData.status;
      log.log('[useAgentStream] forceReconnect: Server status:', agentStatus);

      if (agentStatus !== 'running') {
        log.log('[useAgentStream] forceReconnect: Agent not running');
        setReconnectState('idle');
        reconnectRunIdRef.current = null;
        return { reconnected: false, agentStatus };
      }

      // Step 2: Agent is running - reconnect
      log.log('[useAgentStream] forceReconnect: Agent running, reconnecting...');
      setReconnectState('reconnecting');

      await coreResult.resumeStream();

      // Step 3: Wait for stream to become active
      log.log('[useAgentStream] forceReconnect: Waiting for stream...');
      setReconnectState('waiting');

      return { reconnected: true, agentStatus: 'running' };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn('[useAgentStream] forceReconnect: Error:', errMsg);
      setReconnectState('idle');
      reconnectRunIdRef.current = null;

      const isExpected =
        errMsg.includes('not found') ||
        errMsg.includes('404') ||
        errMsg.includes('does not exist') ||
        errMsg.includes('is not running');

      return { reconnected: false, agentStatus: isExpected ? 'completed' : null };
    }
  }, [coreResult.agentRunId, coreResult.resumeStream, reconnectState]);

  // Compute effective status based on reconnect state machine
  const effectiveStatus = useMemo(() => {
    // During reconnection, ALWAYS show streaming (or reconnecting)
    // This is the KEY fix - no timeouts, just state-based
    if (reconnectState !== 'idle' && reconnectState !== 'done') {
      if (coreResult.status === 'idle' || coreResult.status === 'error') {
        log.log('[useAgentStream] Overriding status during reconnect:', coreResult.status, '→ streaming');
        return 'streaming';
      }
      // If core says reconnecting, that's fine too
      if (coreResult.status === 'reconnecting') {
        return 'reconnecting';
      }
    }
    return coreResult.status;
  }, [reconnectState, coreResult.status]);

  // Compute effective error - suppress benign/expected errors
  const effectiveError = useMemo(() => {
    if (!coreResult.error) return null;

    const errorLower = coreResult.error.toLowerCase();

    // ALWAYS suppress "stream closed unexpectedly" - this happens normally on mobile
    // when user switches threads, backgrounds app, etc. Not a real error.
    const isBenignError =
      errorLower.includes('stream closed unexpectedly') ||
      errorLower.includes('stream closed') ||
      errorLower.includes('connection error');

    if (isBenignError) {
      log.log('[useAgentStream] Suppressing benign error:', coreResult.error);
      return null;
    }

    // During reconnection, suppress all connection-related errors
    if (reconnectState !== 'idle' && reconnectState !== 'done') {
      if (errorLower.includes('connection')) {
        log.log('[useAgentStream] Suppressing connection error during reconnect:', coreResult.error);
        return null;
      }
    }

    return coreResult.error;
  }, [reconnectState, coreResult.error]);

  // Log state overrides for debugging
  if (coreResult.status !== effectiveStatus || coreResult.error !== effectiveError) {
    log.log('[useAgentStream] STATE:', {
      reconnectState,
      coreStatus: coreResult.status,
      effectiveStatus,
      coreError: coreResult.error ? 'has error' : null,
      effectiveError: effectiveError ? 'has error' : null,
      runId: currentRunIdRef.current,
    });
  }

  return {
    status: effectiveStatus,
    textContent: textContentString,
    reasoningContent: coreResult.reasoningContent,
    isReasoningComplete,
    toolCall: coreResult.toolCall,
    error: effectiveError,
    agentRunId: coreResult.agentRunId || currentRunIdRef.current,
    retryCount: coreResult.retryCount,
    startStreaming: coreResult.startStreaming,
    stopStreaming: coreResult.stopStreaming,
    disconnectStream: coreResult.disconnectStream,
    resumeStream: coreResult.resumeStream,
    forceReconnect,
    clearError: coreResult.clearError,
    setError: coreResult.setError,
  };
}
