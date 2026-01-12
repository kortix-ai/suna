import { useCallback, useRef, useEffect, useState, useMemo } from 'react';
import type { UnifiedMessage, ParsedContent, ParsedMetadata } from '../types';
import type { TextChunk } from './text-ordering';
import { safeJsonParse } from '../utils';
import {
  createAccumulatorState,
  clearAccumulator,
  type ToolCallAccumulatorState,
} from './tool-accumulator';
import { orderContentBySequence } from './text-ordering';
import {
  mapAgentStatus,
  preprocessStreamData,
  isCompletionMessage,
  parseStreamingMessage,
  handleAssistantChunk,
  handleToolCallChunk,
  handleToolResult,
  createMessageWithToolCalls,
  extractReasoningContent,
} from './message-handler';

export interface StreamConfig {
  apiUrl: string;
  getAuthToken: () => Promise<string | null>;
  createEventSource: (url: string) => any; // EventSource or react-native-sse EventSource
  queryKeys?: (string | readonly string[])[];
  handleBillingError?: (errorMessage: string, balance?: string | null) => void;
  showToast?: (message: string, type?: 'error' | 'success' | 'warning') => void;
  clearToolTracking?: () => void;
}

export interface UseAgentStreamCoreCallbacks {
  onMessage: (message: UnifiedMessage) => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: string) => void;
  onClose?: (finalStatus: string) => void;
  onAssistantStart?: () => void;
  onAssistantChunk?: (chunk: { content: string }) => void;
  onToolCallChunk?: (message: UnifiedMessage) => void;
  onToolOutputStream?: (data: { tool_call_id: string; tool_name: string; output: string; is_final: boolean }) => void;
}

export interface UseAgentStreamCoreResult {
  status: string;
  textContent: TextChunk[];
  reasoningContent: string;
  toolCall: UnifiedMessage | null;
  error: string | null;
  agentRunId: string | null;
  retryCount: number;
  startStreaming: (runId: string) => Promise<void>;
  stopStreaming: () => Promise<void>;
  resumeStream: () => Promise<void>; // Call when app comes back to foreground
  clearError: () => void; // Clear error state when switching threads
  setError: (error: string) => void; // Set error state (e.g., when retry fails)
}

export interface ContentThrottleConfig {
  type: 'immediate' | 'raf' | 'timeout';
  throttleMs?: number;
}

/**
 * Platform-agnostic core hook for agent streaming
 * Accepts adapter for platform-specific EventSource and API calls
 */
export function useAgentStreamCore(
  config: StreamConfig,
  callbacks: UseAgentStreamCoreCallbacks,
  threadId: string,
  setMessages: (messages: UnifiedMessage[]) => void,
  queryClient?: any,
  throttleConfig: ContentThrottleConfig = { type: 'raf' },
): UseAgentStreamCoreResult {
  const [status, setStatus] = useState<string>('idle');
  const [textContent, setTextContent] = useState<TextChunk[]>([]);
  const [reasoningContent, setReasoningContent] = useState<string>('');
  const [toolCall, setToolCall] = useState<UnifiedMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);

  const streamCleanupRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const currentRunIdRef = useRef<string | null>(null);
  const threadIdRef = useRef(threadId);
  const setMessagesRef = useRef(setMessages);
  const accumulatorRef = useRef<ToolCallAccumulatorState>(createAccumulatorState());
  
  // Content throttling refs
  const rafRef = useRef<number | null>(null);
  const throttleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingContentRef = useRef<{ content: string; sequence?: number }[]>([]);
  const lastFlushTimeRef = useRef<number>(0);
  
  // Tool call throttling refs
  const previousToolCallStateRef = useRef<string | null>(null);
  const lastToolCallUpdateTimeRef = useRef<number>(0);
  const toolCallArgumentsRef = useRef<Map<string, string>>(new Map());
  // Reduced from 100ms to 16ms for smoother real-time tool call streaming
  const THROTTLE_MS = 16;
  
  // Heartbeat detection refs
  const lastMessageTimeRef = useRef<number>(0);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 10 minutes - tools can take a VERY long time, this is just to detect dead connections
  // Not for detecting "no response" - that's the connection timeout's job
  const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000;
  
  // Reconnection refs for graceful handling of bad network
  const retryCountRef = useRef<number>(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isReconnectingRef = useRef<boolean>(false);
  const [retryCount, setRetryCount] = useState<number>(0);
  const MAX_RETRIES = 5;
  const BASE_RETRY_DELAY_MS = 1000;
  
  // Refs for breaking circular dependencies
  const attemptReconnectRef = useRef<((runId: string) => Promise<boolean>) | null>(null);
  
  // Callbacks ref for stable access
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  // Update refs when props change
  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    setMessagesRef.current = setMessages;
  }, [setMessages]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (streamCleanupRef.current) {
        streamCleanupRef.current();
      }
      if (rafRef.current && typeof (globalThis as any).cancelAnimationFrame !== 'undefined') {
        (globalThis as any).cancelAnimationFrame(rafRef.current);
      }
      if (throttleTimeoutRef.current) {
        (globalThis as any).clearTimeout(throttleTimeoutRef.current);
      }
      if (heartbeatIntervalRef.current) {
        (globalThis as any).clearInterval(heartbeatIntervalRef.current);
      }
      if (retryTimeoutRef.current) {
        (globalThis as any).clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  // Content flush function - processes pending content and updates state
  const flushPendingContent = useCallback(() => {
    if (pendingContentRef.current.length > 0) {
      const sortedContent = pendingContentRef.current.slice().sort((a: { content: string; sequence?: number }, b: { content: string; sequence?: number }) => {
        const aSeq = a.sequence ?? 0;
        const bSeq = b.sequence ?? 0;
        return aSeq - bSeq;
      });
      pendingContentRef.current = [];
      
      // Optimized state update - append and dedupe in one pass
      setTextContent((prev: TextChunk[]) => {
        const combined = [...prev, ...sortedContent];
        const deduplicated = new Map<number, { content: string; sequence?: number }>();
        for (const chunk of combined) {
          const seq = chunk.sequence ?? 0;
          deduplicated.set(seq, chunk);
        }
        return Array.from(deduplicated.values()).sort((a: { content: string; sequence?: number }, b: { content: string; sequence?: number }) => {
          const aSeq = a.sequence ?? 0;
          const bSeq = b.sequence ?? 0;
          return aSeq - bSeq;
        });
      });
      lastFlushTimeRef.current = (typeof (globalThis as any).performance !== 'undefined' ? (globalThis as any).performance.now() : Date.now()) as number;
    }
    
    rafRef.current = null;
    throttleTimeoutRef.current = null;
  }, []);

  // Add content - supports immediate, RAF, or timeout modes
  const addContentThrottled = useCallback((content: { content: string; sequence?: number }) => {
    pendingContentRef.current.push(content);
    
    // IMMEDIATE mode - flush synchronously for real-time streaming
    if (throttleConfig.type === 'immediate') {
      flushPendingContent();
      return;
    }
    
    // RAF mode - batch updates to next animation frame
    if (throttleConfig.type === 'raf' && typeof (globalThis as any).requestAnimationFrame !== 'undefined') {
      if (!rafRef.current) {
        rafRef.current = (globalThis as any).requestAnimationFrame(flushPendingContent);
      }
      return;
    }
    
    // Timeout mode - batch updates with configurable delay
    if (!throttleTimeoutRef.current) {
      const throttleMs = throttleConfig.throttleMs || 16;
      throttleTimeoutRef.current = (globalThis as any).setTimeout(() => {
        flushPendingContent();
      }, throttleMs);
    }
  }, [flushPendingContent, throttleConfig]);

  const updateStatus = useCallback((newStatus: string) => {
    if (!isMountedRef.current) return;
    setStatus(newStatus);
    callbacksRef.current.onStatusChange?.(newStatus);
    if (newStatus === 'error' && error) {
      callbacksRef.current.onError?.(error);
    }
    if (['completed', 'stopped', 'failed', 'error', 'agent_not_running'].includes(newStatus)) {
      callbacksRef.current.onClose?.(newStatus);
    }
  }, [error]);

  const orderedTextContent = useMemo(() => {
    // Return ordered chunks array for type compatibility, but components expect string
    // So we'll return the array and let the wrapper convert it
    if (textContent.length === 0) return [];
    const sorted = [...textContent].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    return sorted;
  }, [textContent]);

  // Finalize stream function
  const finalizeStream = useCallback(
    (finalStatus: string, runId: string | null = agentRunId) => {
      if (!isMountedRef.current) return;

      if (runId && currentRunIdRef.current && currentRunIdRef.current !== runId) {
        return;
      }

      if (streamCleanupRef.current) {
        streamCleanupRef.current();
        streamCleanupRef.current = null;
      }

      if (rafRef.current && typeof (globalThis as any).cancelAnimationFrame !== 'undefined') {
        (globalThis as any).cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (throttleTimeoutRef.current) {
        (globalThis as any).clearTimeout(throttleTimeoutRef.current);
        throttleTimeoutRef.current = null;
      }
      if (heartbeatIntervalRef.current) {
        (globalThis as any).clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      pendingContentRef.current = [];

      setTextContent([]);
      setToolCall(null);
      clearAccumulator(accumulatorRef.current);
      toolCallArgumentsRef.current.clear();
      previousToolCallStateRef.current = null;
      lastToolCallUpdateTimeRef.current = 0;
      
      if (config.clearToolTracking) {
        config.clearToolTracking();
      }

      updateStatus(finalStatus);
      setAgentRunId(null);
      currentRunIdRef.current = null;

      // Invalidate queries
      if (queryClient && config.queryKeys && config.queryKeys.length > 0) {
        config.queryKeys.forEach((key) => {
          queryClient.invalidateQueries({ queryKey: Array.isArray(key) ? key : [key] });
        });
      }
    },
    [agentRunId, updateStatus, config, queryClient],
  );

  // Handle billing errors
  const handleBillingError = useCallback((errorMessage: string) => {
    const messageLower = errorMessage.toLowerCase();
    const isCreditsExhausted = 
      messageLower.includes('insufficient credits') ||
      messageLower.includes('out of credits') ||
      messageLower.includes('no credits') ||
      messageLower.includes('balance');
    
    const balanceMatch = errorMessage.match(/balance is (-?\d+)\s*credits/i);
    const balance = balanceMatch ? balanceMatch[1] : null;
    
    if (config.handleBillingError) {
      config.handleBillingError(errorMessage, balance);
    } else {
      setError(errorMessage);
      callbacksRef.current.onError?.(errorMessage);
    }
  }, [config]);

  // Stream message handler
  const handleStreamMessage = useCallback((rawData: string) => {
    if (!isMountedRef.current) return;
    if (threadIdRef.current !== threadId) return;

    lastMessageTimeRef.current = Date.now();

    const processedData = preprocessStreamData(rawData);
    if (!processedData || processedData.trim() === '') {
      return;
    }

    // Early exit for completion messages
    if (isCompletionMessage(processedData)) {
      finalizeStream('completed', currentRunIdRef.current);
      return;
    }

    // Check for error messages and special message types
    try {
      const jsonData = JSON.parse(processedData);
      
      if (jsonData.status === 'error') {
        const errorMessage = jsonData.message || 'Unknown error occurred';
        const messageLower = errorMessage.toLowerCase();
        const isBillingError = 
          messageLower.includes('insufficient credits') ||
          messageLower.includes('credit') ||
          messageLower.includes('balance') ||
          messageLower.includes('out of credits') ||
          messageLower.includes('no credits') ||
          messageLower.includes('billing check failed');
        
        if (isBillingError) {
          handleBillingError(errorMessage);
          finalizeStream('error', currentRunIdRef.current);
          return;
        }
        
        setError(errorMessage);
        callbacksRef.current.onError?.(errorMessage);
        if (config.showToast) {
          config.showToast(errorMessage, 'error');
        }
        // CRITICAL: Finalize stream on error so UI doesn't stay stuck in loading
        finalizeStream('error', currentRunIdRef.current);
        return;
      }
      
      // Handle stopped status (normal completion or billing error)
      if (jsonData.type === 'status' && jsonData.status === 'stopped') {
        if (jsonData.message) {
          const message = jsonData.message.toLowerCase();
          const isBillingError = 
            message.includes('insufficient credits') ||
            message.includes('credit') ||
            message.includes('balance') ||
            message.includes('out of credits') ||
            message.includes('no credits') ||
            message.includes('billing check failed');
          
          if (isBillingError) {
            handleBillingError(jsonData.message);
          }
        }
        finalizeStream('stopped', currentRunIdRef.current);
        return;
      }
      
      // Handle completed status
      if (jsonData.type === 'status' && jsonData.status === 'completed') {
        finalizeStream('completed', currentRunIdRef.current);
        return;
      }
      
      // Handle tool_output_stream messages
      if (jsonData.type === 'tool_output_stream') {
        callbacksRef.current.onToolOutputStream?.({
          tool_call_id: jsonData.tool_call_id,
          tool_name: jsonData.tool_name,
          output: jsonData.output,
          is_final: jsonData.is_final,
        });
        return;
      }
      
      // Handle ping messages
      if (jsonData.type === 'ping' && !jsonData.content) {
        return;
      }
    } catch {
      // Not JSON, continue processing
    }

    // Process streaming messages
    const message = parseStreamingMessage(processedData);
    if (!message) {
      console.warn('[useAgentStreamCore] Failed to parse streamed message:', processedData);
      return;
    }

    const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
    const parsedMetadata = safeJsonParse<ParsedMetadata>(message.metadata, {});

    // Update status to streaming if we receive a valid message
    if (status !== 'streaming') {
      updateStatus('streaming');
    }

    switch (message.type) {
      case 'assistant':
        // CRITICAL: Extract reasoning content FIRST, before any other processing
        // This ensures reasoning chunks appear in frontend as soon as possible
        const reasoningChunk = extractReasoningContent(parsedContent, parsedMetadata);
        if (reasoningChunk) {
          // Update reasoning content immediately - no throttling, no delay
          setReasoningContent((prev) => prev + reasoningChunk);
        }
        
        if (parsedMetadata.stream_status === 'tool_call_chunk') {
          // Handle tool call chunks - accumulate arguments smoothly
          const reconstructedToolCalls = handleToolCallChunk(
            message,
            parsedMetadata,
            accumulatorRef.current
          );
          
          if (reconstructedToolCalls) {
            // Update accumulated arguments for each tool call
            reconstructedToolCalls.forEach(tc => {
              toolCallArgumentsRef.current.set(tc.tool_call_id, tc.arguments);
            });
            
            // Create message with current accumulated arguments
            const updatedMessage = createMessageWithToolCalls(
              message,
              parsedMetadata,
              reconstructedToolCalls
            );
            
            // Throttle tool call updates to allow smooth streaming
            // Include argument lengths to detect content changes (not just structure)
            const currentStateKey = JSON.stringify({
              toolCallIds: reconstructedToolCalls.map(tc => tc.tool_call_id),
              functionNames: reconstructedToolCalls.map(tc => tc.function_name),
              count: reconstructedToolCalls.length,
              // Include argument lengths so we detect content updates
              argLengths: reconstructedToolCalls.map(tc => tc.arguments?.length || 0),
            });
            
            const hasChanged = previousToolCallStateRef.current !== currentStateKey;
            const now = (typeof (globalThis as any).performance !== 'undefined' ? (globalThis as any).performance.now() : Date.now()) as number;
            const timeSinceLastUpdate = now - lastToolCallUpdateTimeRef.current;
            
            // Check if structure changed (new tool calls added, function names changed)
            let structureChanged = false;
            if (hasChanged && previousToolCallStateRef.current !== null) {
              try {
                const currentState = JSON.parse(currentStateKey);
                const previousState = JSON.parse(previousToolCallStateRef.current);
                structureChanged = currentState.count !== previousState.count ||
                  JSON.stringify(currentState.functionNames) !== JSON.stringify(previousState.functionNames);
              } catch {
                structureChanged = true;
              }
            } else if (hasChanged) {
              structureChanged = true;
            }
            
            // Always update immediately if structure changed (new tool calls)
            // Otherwise throttle argument updates, but still update regularly
            const shouldUpdate = structureChanged || (hasChanged && timeSinceLastUpdate >= THROTTLE_MS);
            
            if (shouldUpdate) {
              previousToolCallStateRef.current = currentStateKey;
              lastToolCallUpdateTimeRef.current = now;
              setToolCall(updatedMessage);
            }
            
            // Always call onToolCallChunk callback for real-time updates
            // Components can use useSmoothToolField to smooth the arguments
            callbacksRef.current.onToolCallChunk?.(updatedMessage);
          }
        } else {
          // Handle text chunks
          const chunkContent = handleAssistantChunk(message, parsedContent, parsedMetadata);
          if (chunkContent) {
            addContentThrottled({
              sequence: message.sequence,
              content: chunkContent,
            });
            callbacksRef.current.onAssistantChunk?.({ content: chunkContent });
          }
          
          if (parsedMetadata.stream_status === 'complete') {
            // Flush pending content before completing
            flushPendingContent();
            flushPendingContent();
            setTextContent([]);
            // Don't clear reasoning content - it should persist
            setToolCall(null);
            clearAccumulator(accumulatorRef.current);
            toolCallArgumentsRef.current.clear();
            previousToolCallStateRef.current = null;
            lastToolCallUpdateTimeRef.current = 0;
            if (message.message_id) callbacksRef.current.onMessage(message);
          } else if (!parsedMetadata.stream_status) {
            callbacksRef.current.onAssistantStart?.();
            if (message.message_id) callbacksRef.current.onMessage(message);
          }
        }
        break;
        
      case 'tool':
        // Handle tool result - DON'T re-set toolCall state!
        // The stream is already complete (stream_status: 'complete' was received earlier)
        // Re-setting toolCall would cause the streaming content to re-appear and re-animate
        const reconstructedToolCallsFromResult = handleToolResult(
          message,
          parsedMetadata,
          accumulatorRef.current
        );
        
        if (reconstructedToolCallsFromResult) {
          const updatedMessageWithResults = createMessageWithToolCalls(
            message,
            parsedMetadata,
            reconstructedToolCallsFromResult
          );
          
          // Only call the callback for tool view updates, don't update streaming state
          // This prevents the ask/complete animation from replaying after stream completes
          callbacksRef.current.onToolCallChunk?.(updatedMessageWithResults);
        }
        
        if (message.message_id) callbacksRef.current.onMessage(message);
        break;
        
      case 'status':
        switch (parsedContent.status_type) {
          case 'tool_completed':
          case 'tool_failed':
          case 'tool_error':
            // Don't clear toolCall state - other tools may still be streaming
            break;
          case 'finish':
            // Optional: Handle finish reasons
            break;
          case 'error':
            setError(parsedContent.message || 'Worker run failed');
            finalizeStream('error', currentRunIdRef.current);
            break;
          default:
            break;
        }
        break;
        
      case 'llm_response_end':
      case 'llm_response_start':
        // Ignore metadata-only messages
        break;
        
      case 'user':
      case 'system':
        if (message.message_id) callbacksRef.current.onMessage(message);
        break;
        
      default:
        console.warn('[useAgentStreamCore] Unhandled message type:', message.type);
    }
  }, [threadId, status, callbacks, updateStatus, finalizeStream, addContentThrottled, flushPendingContent, handleBillingError]);

  // Handle stream error
  const handleStreamError = useCallback((err: any) => {
    if (!isMountedRef.current) return;

    let errorMessage = 'Unknown streaming error';
    if (typeof err === 'string') {
      errorMessage = err;
    } else if (err instanceof Error) {
      errorMessage = err.message;
    } else if (err && typeof err === 'object') {
      if (err.xhrStatus === 404) {
        errorMessage = 'Stream endpoint not found (404) - run may still be initializing';
      } else if (err.message) {
        errorMessage = err.message;
      } else if (err.type === 'error') {
        errorMessage = 'Stream connection error';
      }
    }

    const lower = errorMessage.toLowerCase();
    const isExpected = lower.includes('not found') || lower.includes('not running') || lower.includes('404');

    if (!isExpected) {
      console.error('[useAgentStreamCore] Streaming error:', errorMessage, err);
      setError(errorMessage);
      if (config.showToast) {
        config.showToast(errorMessage, 'error');
      }
    }

    const runId = currentRunIdRef.current;
    if (!runId) {
      finalizeStream('error');
      return;
    }
  }, [finalizeStream, config]);

  // Shared API functions
  const getAgentStatus = useCallback(async (runId: string, config: StreamConfig): Promise<{ status: string; error?: string }> => {
    const token = await config.getAuthToken();
    const url = `${config.apiUrl}/agent-runs/${runId}/status`;
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Failed to get agent status: ${response.status}`);
    }
    return response.json();
  }, []);

  // Handle stream close
  const handleStreamClose = useCallback(() => {
    if (!isMountedRef.current) return;

    const runId = currentRunIdRef.current;
    const currentStatus = status;

    // If already finalized, don't show error
    if (['completed', 'stopped', 'error', 'agent_not_running'].includes(currentStatus)) {
      return;
    }

    if (!runId) {
      if (currentStatus === 'streaming' || currentStatus === 'connecting') {
        finalizeStream('error');
      } else if (currentStatus !== 'idle') {
        finalizeStream('idle');
      }
      return;
    }

    // Wait a bit for DB to update
    (globalThis as any).setTimeout(() => {
      if (!isMountedRef.current) return;
      if (currentRunIdRef.current !== runId) return;

      // Double-check status wasn't finalized while waiting
      if (['completed', 'stopped', 'error', 'agent_not_running'].includes(status)) {
        return;
      }

      // Get agent status using shared API call
      getAgentStatus(runId, config)
        .then((agentStatus: { status: string; error?: string }) => {
          if (!isMountedRef.current) return;
          if (currentRunIdRef.current !== runId) return;
          if (['completed', 'stopped', 'error', 'agent_not_running'].includes(status)) {
            return;
          }

          if (agentStatus.status === 'running') {
            setError('Stream closed unexpectedly while agent was running.');
            finalizeStream('error', runId);
            if (config.showToast) {
              config.showToast('Stream disconnected. Worker might still be running.', 'warning');
            }
          } else if (agentStatus.status === 'stopped' && agentStatus.error) {
            const errorMessage = agentStatus.error;
            const lower = errorMessage.toLowerCase();
            const isBillingError = 
              lower.includes('insufficient credits') ||
              lower.includes('credit') ||
              lower.includes('balance') ||
              lower.includes('out of credits') ||
              lower.includes('no credits') ||
              lower.includes('billing check failed');
            
            if (isBillingError) {
              handleBillingError(errorMessage);
            }
            
            const finalStatus = mapAgentStatus(agentStatus.status);
            finalizeStream(finalStatus, runId);
          } else {
            const finalStatus = mapAgentStatus(agentStatus.status);
            finalizeStream(finalStatus, runId);
          }
        })
        .catch((err: unknown) => {
          if (!isMountedRef.current) return;
          if (currentRunIdRef.current !== runId) return;

          const errorMessage = err instanceof Error ? err.message : String(err);
          const isExpectedCompletion =
            errorMessage.includes('not found') ||
            errorMessage.includes('404') ||
            errorMessage.includes('does not exist') ||
            errorMessage.includes('is not running');

          if (isExpectedCompletion) {
            finalizeStream('agent_not_running', runId);
          } else {
            console.error(`[useAgentStreamCore] Error checking agent status for ${runId} after stream close: ${errorMessage}`);
            finalizeStream('error', runId);
          }
        });
    }, 500);
  }, [status, finalizeStream, config, handleBillingError, getAgentStatus]);

  // Internal function that sets up the EventSource and handlers
  const setupEventSource = useCallback(async (runId: string, isReconnect: boolean = false): Promise<boolean> => {
    if (!isMountedRef.current) return false;
    
    // Create EventSource
    const token = await config.getAuthToken();
    const streamUrl = `${config.apiUrl}/agent-run/${runId}/stream${token ? `?token=${token}` : ''}`;
    const eventSource = config.createEventSource(streamUrl);

    // Connection timeout - if onopen doesn't fire within 15 seconds, treat as error
    const CONNECTION_TIMEOUT_MS = 15000;
    let connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let connectionOpened = false;

    const cleanup = () => {
      // Clear connection timeout
      if (connectionTimeoutId) {
        (globalThis as any).clearTimeout(connectionTimeoutId);
        connectionTimeoutId = null;
      }
      try {
        if (eventSource && typeof eventSource.close === 'function') {
          eventSource.close();
        }
        if (eventSource && typeof eventSource.removeAllEventListeners === 'function') {
          eventSource.removeAllEventListeners();
        }
      } catch (err) {
        console.warn('[useAgentStreamCore] Error closing event source:', err);
      }
    };

    streamCleanupRef.current = cleanup;

    return new Promise((resolve) => {
      let resolved = false;

      // Set up connection timeout
      connectionTimeoutId = (globalThis as any).setTimeout(async () => {
        if (connectionOpened || resolved) return;
        
        console.warn(`[useAgentStreamCore] Connection timeout after ${CONNECTION_TIMEOUT_MS}ms for ${runId}`);
        cleanup();
        
        // Attempt reconnect on timeout
        if (attemptReconnectRef.current) {
          const reconnected = await attemptReconnectRef.current(runId);
          if (!reconnected) {
            setError('Connection timeout - please check your internet');
            callbacksRef.current.onError?.('Connection timeout - please check your internet');
            finalizeStream('error', runId);
          }
          if (!resolved) { resolved = true; resolve(reconnected); }
        } else {
          setError('Connection timeout - please check your internet');
          callbacksRef.current.onError?.('Connection timeout - please check your internet');
          finalizeStream('error', runId);
          if (!resolved) { resolved = true; resolve(false); }
        }
      }, CONNECTION_TIMEOUT_MS);
      
      // Handle messages
      const messageHandler = (event: any) => {
        if (currentRunIdRef.current === runId && threadIdRef.current === threadId) {
          handleStreamMessage(event.data || event);
        }
      };

      // Handle errors with reconnection support
      const errorHandler = async (event: any) => {
        if (currentRunIdRef.current !== runId) return;
        
        // Check agent status on error
        try {
          const agentStatus = await getAgentStatus(runId, config);
          if (agentStatus.status !== 'running') {
            // Agent finished - no need to reconnect
            updateStatus(mapAgentStatus(agentStatus.status));
            cleanup();
            callbacksRef.current.onClose?.(mapAgentStatus(agentStatus.status));
            if (!resolved) { resolved = true; resolve(false); }
            return;
          }
          
          // Agent is still running but connection failed - attempt reconnect
          console.log('[useAgentStreamCore] Connection error while agent running, attempting reconnect...');
          cleanup();
          if (attemptReconnectRef.current) {
            const reconnected = await attemptReconnectRef.current(runId);
            if (!reconnected) {
              // Max retries exceeded
              handleStreamError(event);
              finalizeStream('error', runId);
            }
            if (!resolved) { resolved = true; resolve(reconnected); }
          } else {
            handleStreamError(event);
            finalizeStream('error', runId);
            if (!resolved) { resolved = true; resolve(false); }
          }
          return;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isExpected = 
            errMsg.includes('not found') ||
            errMsg.includes('404') ||
            errMsg.includes('does not exist') ||
            errMsg.includes('is not running');
          
          if (isExpected) {
            updateStatus('completed');
            cleanup();
            callbacksRef.current.onClose?.('completed');
            if (!resolved) { resolved = true; resolve(false); }
            return;
          }
          
          // Network error checking status - attempt reconnect anyway
          console.log('[useAgentStreamCore] Status check failed, attempting reconnect...');
          cleanup();
          if (attemptReconnectRef.current) {
            const reconnected = await attemptReconnectRef.current(runId);
            if (!reconnected) {
              handleStreamError(event);
              finalizeStream('error', runId);
            }
            if (!resolved) { resolved = true; resolve(reconnected); }
          } else {
            handleStreamError(event);
            finalizeStream('error', runId);
            if (!resolved) { resolved = true; resolve(false); }
          }
        }
      };

      // Handle close
      const closeHandler = () => {
        if (currentRunIdRef.current === runId) {
          handleStreamClose();
        }
      };

      // Handle open - connection succeeded
      const openHandler = () => {
        if (currentRunIdRef.current === runId) {
          // Mark connection as opened and clear timeout
          connectionOpened = true;
          if (connectionTimeoutId) {
            (globalThis as any).clearTimeout(connectionTimeoutId);
            connectionTimeoutId = null;
          }
          
          // Reset retry state on successful connection
          retryCountRef.current = 0;
          setRetryCount(0);
          isReconnectingRef.current = false;
          
          updateStatus('streaming');
          lastMessageTimeRef.current = Date.now();
          
          if (heartbeatIntervalRef.current) {
            (globalThis as any).clearInterval(heartbeatIntervalRef.current);
          }
          heartbeatIntervalRef.current = (globalThis as any).setInterval(() => {
            if (!isMountedRef.current || currentRunIdRef.current !== runId) {
              if (heartbeatIntervalRef.current) {
                (globalThis as any).clearInterval(heartbeatIntervalRef.current);
                heartbeatIntervalRef.current = null;
              }
              return;
            }
            
            const timeSinceLastMessage = Date.now() - lastMessageTimeRef.current;
            if (timeSinceLastMessage > HEARTBEAT_TIMEOUT_MS) {
              console.warn(`[useAgentStreamCore] No message received for ${timeSinceLastMessage}ms, checking agent status`);
              getAgentStatus(runId, config)
                .then((statusResult: { status: string; error?: string }) => {
                  if (!isMountedRef.current || currentRunIdRef.current !== runId) return;
                  if (statusResult.status !== 'running') {
                    // Agent finished - finalize stream
                    finalizeStream(mapAgentStatus(statusResult.status), runId);
                  } else {
                    // Agent is still running and we can reach the server - stream is fine!
                    // Tool is just taking time to execute. Reset the timer and keep waiting.
                    console.log('[useAgentStreamCore] Agent still running (tool executing), resetting heartbeat timer');
                    lastMessageTimeRef.current = Date.now();
                  }
                })
                .catch((err) => {
                  // NETWORK ERROR - can't reach server, THIS is when we reconnect
                  console.warn('[useAgentStreamCore] Heartbeat status check failed (network error), attempting reconnect...', err);
                  if (!isMountedRef.current || currentRunIdRef.current !== runId) return;
                  cleanup();
                  if (attemptReconnectRef.current) {
                    attemptReconnectRef.current(runId);
                  }
                });
            }
          }, 10000);
          
          if (!resolved) { resolved = true; resolve(true); }
        }
      };

      // Attach handlers
      if (eventSource.addEventListener) {
        eventSource.addEventListener('message', messageHandler);
        eventSource.addEventListener('error', errorHandler);
        eventSource.addEventListener('close', closeHandler);
        eventSource.addEventListener('open', openHandler);
      } else {
        eventSource.onmessage = messageHandler;
        eventSource.onerror = errorHandler;
        eventSource.onclose = closeHandler;
        eventSource.onopen = openHandler;
      }
    });
  }, [config, threadId, handleStreamMessage, handleStreamError, handleStreamClose, updateStatus, getAgentStatus, finalizeStream]);

  // Attempt reconnection with exponential backoff
  const attemptReconnect = useCallback(async (runId: string): Promise<boolean> => {
    if (!isMountedRef.current) return false;
    if (retryCountRef.current >= MAX_RETRIES) {
      console.warn(`[useAgentStreamCore] Max retries (${MAX_RETRIES}) exceeded for ${runId}`);
      isReconnectingRef.current = false;
      return false;
    }

    retryCountRef.current += 1;
    setRetryCount(retryCountRef.current);
    isReconnectingRef.current = true;
    
    // Calculate exponential backoff delay
    const delay = BASE_RETRY_DELAY_MS * Math.pow(2, retryCountRef.current - 1);
    console.log(`[useAgentStreamCore] Reconnecting (attempt ${retryCountRef.current}/${MAX_RETRIES}) in ${delay}ms...`);
    
    setStatus('reconnecting');
    callbacksRef.current.onStatusChange?.('reconnecting');

    return new Promise((resolve) => {
      retryTimeoutRef.current = (globalThis as any).setTimeout(async () => {
        if (!isMountedRef.current || currentRunIdRef.current !== runId) {
          isReconnectingRef.current = false;
          resolve(false);
          return;
        }

        // Verify agent is still running before reconnecting
        try {
          const agentStatus = await getAgentStatus(runId, config);
          if (agentStatus.status !== 'running') {
            console.log(`[useAgentStreamCore] Agent no longer running (${agentStatus.status}), stopping reconnect`);
            isReconnectingRef.current = false;
            finalizeStream(mapAgentStatus(agentStatus.status), runId);
            resolve(false);
            return;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isExpected = 
            errMsg.includes('not found') ||
            errMsg.includes('404') ||
            errMsg.includes('does not exist') ||
            errMsg.includes('is not running');
          
          if (isExpected) {
            isReconnectingRef.current = false;
            finalizeStream('completed', runId);
            resolve(false);
            return;
          }
          // Status check failed due to network - continue with reconnect attempt
        }

        // Use setupEventSource for reconnection
        try {
          const success = await setupEventSource(runId, true);
          resolve(success);
        } catch (err) {
          console.error('[useAgentStreamCore] Error during reconnect:', err);
          // Recursive retry
          attemptReconnect(runId).then(resolve);
        }
      }, delay);
    });
  }, [config, getAgentStatus, finalizeStream, setupEventSource]);

  // Update ref for setupEventSource to use
  useEffect(() => {
    attemptReconnectRef.current = attemptReconnect;
  }, [attemptReconnect]);

  const startStreaming = useCallback(async (runId: string) => {
    if (!isMountedRef.current) return;

    // Cleanup previous stream
    if (streamCleanupRef.current) {
      streamCleanupRef.current();
    }

    // Reset state
    if (rafRef.current && typeof (globalThis as any).cancelAnimationFrame !== 'undefined') {
      (globalThis as any).cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (throttleTimeoutRef.current) {
      (globalThis as any).clearTimeout(throttleTimeoutRef.current);
      throttleTimeoutRef.current = null;
    }
    if (retryTimeoutRef.current) {
      (globalThis as any).clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    pendingContentRef.current = [];
    
    // Reset retry state on fresh start
    retryCountRef.current = 0;
    setRetryCount(0);
    isReconnectingRef.current = false;
    
    // Clear reasoning content when starting a new stream
    setReasoningContent('');
    
    currentRunIdRef.current = runId;
    setAgentRunId(runId);
    setTextContent([]);
    setToolCall(null);
    setError(null);
    updateStatus('connecting');
    clearAccumulator(accumulatorRef.current);
    previousToolCallStateRef.current = null;
    lastToolCallUpdateTimeRef.current = 0;
    
    if (config.clearToolTracking) {
      config.clearToolTracking();
    }

    // Setup EventSource with all handlers
    await setupEventSource(runId, false);
  }, [config, updateStatus, setupEventSource]);

  const stopStreaming = useCallback(async () => {
    if (streamCleanupRef.current) {
      streamCleanupRef.current();
    }
    
    if (currentRunIdRef.current) {
      try {
        const runId = currentRunIdRef.current;
        const token = await config.getAuthToken();
        const url = `${config.apiUrl}/agent-runs/${runId}/stop`;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        
        await fetch(url, {
          method: 'POST',
          headers,
        });
        
        if (config.showToast) {
          config.showToast('Worker stopped.', 'success');
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('[useAgentStreamCore] Error stopping agent:', err);
        if (config.showToast) {
          config.showToast(`Failed to stop Worker: ${errorMessage}`, 'error');
        }
      }
      currentRunIdRef.current = null;
    }
    
    finalizeStream('stopped', agentRunId);
  }, [config, agentRunId, finalizeStream]);

  // Resume stream when app comes back to foreground
  // This is called when app returns from background - the EventSource might be dead/stale
  const resumeStream = useCallback(async () => {
    const runId = currentRunIdRef.current;
    if (!runId) {
      console.log('[useAgentStreamCore] No active run to resume');
      return;
    }

    // If already reconnecting, don't stack calls
    if (isReconnectingRef.current) {
      console.log('[useAgentStreamCore] Already reconnecting, skipping resume');
      return;
    }

    console.log('[useAgentStreamCore] Resuming stream for run:', runId);

    // ALWAYS check agent status on resume - even if we think we're streaming,
    // the EventSource might be dead after app was backgrounded
    try {
      const agentStatus = await getAgentStatus(runId, config);
      if (agentStatus.status !== 'running') {
        console.log(`[useAgentStreamCore] Agent no longer running (${agentStatus.status}), finalizing`);
        finalizeStream(mapAgentStatus(agentStatus.status), runId);
        return;
      }

      // Agent still running - need to check if we're actually receiving messages
      // If status is 'streaming' and we recently got a message, we're probably fine
      const timeSinceLastMessage = Date.now() - lastMessageTimeRef.current;
      if (status === 'streaming' && timeSinceLastMessage < 5000) {
        console.log('[useAgentStreamCore] Stream appears healthy, skipping reconnect');
        return;
      }

      // Agent is running but stream might be stale - reconnect
      console.log('[useAgentStreamCore] Agent still running, reconnecting stream...');
      
      // Clean up any stale stream
      if (streamCleanupRef.current) {
        streamCleanupRef.current();
      }
      
      // Reset retry state for fresh reconnect
      retryCountRef.current = 0;
      setRetryCount(0);
      isReconnectingRef.current = false;
      
      updateStatus('connecting');
      await setupEventSource(runId, false);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isExpected = 
        errMsg.includes('not found') ||
        errMsg.includes('404') ||
        errMsg.includes('does not exist') ||
        errMsg.includes('is not running');
      
      if (isExpected) {
        console.log('[useAgentStreamCore] Agent completed while app was backgrounded');
        finalizeStream('completed', runId);
      } else {
        console.warn('[useAgentStreamCore] Error checking agent status on resume:', err);
        // Network error - try to reconnect
        if (streamCleanupRef.current) {
          streamCleanupRef.current();
        }
        updateStatus('reconnecting');
        if (attemptReconnectRef.current) {
          attemptReconnectRef.current(runId);
        }
      }
    }
  }, [config, status, getAgentStatus, finalizeStream, updateStatus, setupEventSource]);

  // Clear error state - useful when switching threads
  const clearError = useCallback(() => {
    setError(null);
    updateStatus('idle');
    retryCountRef.current = 0;
    setRetryCount(0);
    isReconnectingRef.current = false;
  }, [updateStatus]);

  // Set error state - useful when retry fails
  const setStreamError = useCallback((errorMessage: string) => {
    setError(errorMessage);
    updateStatus('error');
  }, [updateStatus]);

  return {
    status,
    textContent: orderedTextContent,
    reasoningContent,
    toolCall,
    error,
    agentRunId,
    retryCount,
    startStreaming,
    stopStreaming,
    resumeStream,
    clearError,
    setError: setStreamError,
  };
}
