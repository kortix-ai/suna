'use client';

import { useCallback, useRef, useEffect, useState, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AgentStatus,
  ToolCallAccumulatorState,
  ToolOutputStreamData,
  ConnectionState,
} from './types';
import type { UnifiedMessage } from '@/components/thread/types';
import { STREAM_CONFIG, TERMINAL_STATUSES } from './constants';
import { 
  mapBackendStatus, 
  isTerminalStatus,
  extractBillingErrorContext,
} from './utils';
import { 
  processStreamData, 
  createMessageWithToolCalls,
  streamMessageToUnifiedMessage,
} from './message-processor';
import { 
  createAccumulatorState, 
  clearAccumulator,
  reconstructToolCalls,
} from './tool-accumulator';
import { StreamConnection } from './stream-connection';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export interface AgentStreamCallbacks {
  onMessage: (message: UnifiedMessage) => void;
  onStatusChange?: (status: AgentStatus) => void;
  onError?: (error: string) => void;
  onClose?: (finalStatus: string) => void;
  onAssistantStart?: () => void;
  onAssistantChunk?: (chunk: { content: string }) => void;
  onToolCallChunk?: (message: UnifiedMessage) => void;
  onToolOutputStream?: (data: ToolOutputStreamData) => void;
}

export interface UseAgentStreamOptions {
  handleBillingError?: (errorMessage: string, balance?: string | null) => void;
  showToast?: (message: string, type?: 'error' | 'success' | 'warning') => void;
  clearToolTracking?: () => void;
  queryKeys?: (string | readonly string[])[];
}

export interface UseAgentStreamResult {
  status: AgentStatus;
  textContent: string;
  reasoningContent: string;
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
  options: UseAgentStreamOptions = {}
): UseAgentStreamResult {
  const queryClient = useQueryClient();
  
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [textChunks, setTextChunks] = useState<Array<{ content: string; sequence: number }>>([]);
  const [reasoningContent, setReasoningContent] = useState('');
  const [toolCall, setToolCall] = useState<UnifiedMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  
  const connectionRef = useRef<StreamConnection | null>(null);
  const accumulatorRef = useRef<ToolCallAccumulatorState>(createAccumulatorState());
  const currentRunIdRef = useRef<string | null>(null);
  const threadIdRef = useRef(threadId);
  const isMountedRef = useRef(true);
  
  const callbacksRef = useRef(callbacks);
  const optionsRef = useRef(options);
  const setMessagesRef = useRef(setMessages);
  const handleStreamMessageRef = useRef<((rawData: string) => void) | null>(null);
  const handleConnectionErrorRef = useRef<((error: Error) => void) | null>(null);
  const handleConnectionCloseRef = useRef<(() => void) | null>(null);
  const statusRef = useRef(status);
  
  const pendingChunksRef = useRef<Array<{ content: string; sequence: number }>>([]);
  const rafIdRef = useRef<number | null>(null);
  
  const toolCallThrottleRef = useRef<{
    lastUpdate: number;
    pendingUpdate: UnifiedMessage | null;
    timeoutId: ReturnType<typeof setTimeout> | null;
  }>({
    lastUpdate: 0,
    pendingUpdate: null,
    timeoutId: null,
  });
  
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);
  
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  
  useEffect(() => {
    setMessagesRef.current = setMessages;
  }, [setMessages]);
  
  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);
  
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (toolCallThrottleRef.current.timeoutId) {
        clearTimeout(toolCallThrottleRef.current.timeoutId);
      }
    };
  }, []);
  
  const textContent = useMemo(() => {
    if (textChunks.length === 0) return '';
    const sorted = [...textChunks].sort((a, b) => a.sequence - b.sequence);
    return sorted.map(chunk => chunk.content).join('');
  }, [textChunks]);
  
  const flushPendingChunks = useCallback(() => {
    if (!isMountedRef.current) return;
    
    if (pendingChunksRef.current.length > 0) {
      const chunksToAdd = [...pendingChunksRef.current];
      pendingChunksRef.current = [];
      
      setTextChunks(prev => {
        const combined = [...prev, ...chunksToAdd];
        const deduplicated = new Map<number, { content: string; sequence: number }>();
        for (const chunk of combined) {
          deduplicated.set(chunk.sequence, chunk);
        }
        return Array.from(deduplicated.values()).sort((a, b) => a.sequence - b.sequence);
      });
    }
    
    rafIdRef.current = null;
  }, []);
  
  const addTextChunk = useCallback((content: string, sequence: number) => {
    pendingChunksRef.current.push({ content, sequence });
    
    if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(flushPendingChunks);
    }
  }, [flushPendingChunks]);
  
  const updateToolCall = useCallback((message: UnifiedMessage) => {
    const now = performance.now();
    const throttle = toolCallThrottleRef.current;
    const timeSinceLastUpdate = now - throttle.lastUpdate;
    
    if (timeSinceLastUpdate >= STREAM_CONFIG.TOOL_CALL_THROTTLE_MS) {
      throttle.lastUpdate = now;
      setToolCall(message);
      callbacksRef.current.onToolCallChunk?.(message);
    } else {
      throttle.pendingUpdate = message;
      
      if (!throttle.timeoutId) {
        throttle.timeoutId = setTimeout(() => {
          if (isMountedRef.current && throttle.pendingUpdate) {
            throttle.lastUpdate = performance.now();
            setToolCall(throttle.pendingUpdate);
            callbacksRef.current.onToolCallChunk?.(throttle.pendingUpdate);
            throttle.pendingUpdate = null;
          }
          throttle.timeoutId = null;
        }, STREAM_CONFIG.TOOL_CALL_THROTTLE_MS - timeSinceLastUpdate);
      }
    }
  }, []);
  
  const invalidateQueries = useCallback(() => {
    const keys = optionsRef.current.queryKeys || [];
    keys.forEach((key) => {
      queryClient.invalidateQueries({ queryKey: Array.isArray(key) ? key : [key] });
    });
  }, [queryClient]);
  
  const resetState = useCallback(() => {
    setTextChunks([]);
    setReasoningContent('');
    setToolCall(null);
    setError(null);
    clearAccumulator(accumulatorRef.current);
    pendingChunksRef.current = [];
    
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    
    if (toolCallThrottleRef.current.timeoutId) {
      clearTimeout(toolCallThrottleRef.current.timeoutId);
      toolCallThrottleRef.current.timeoutId = null;
    }
    toolCallThrottleRef.current.pendingUpdate = null;
    toolCallThrottleRef.current.lastUpdate = 0;
    
    optionsRef.current.clearToolTracking?.();
  }, []);
  
  const finalizeStream = useCallback((finalStatus: AgentStatus, runId: string | null = agentRunId) => {
    if (!isMountedRef.current) return;

    if (runId && currentRunIdRef.current && currentRunIdRef.current !== runId) {
      return;
    }

    if (connectionRef.current) {
      connectionRef.current.destroy();
      connectionRef.current = null;
    }

    flushPendingChunks();

    setStatus(finalStatus);
    callbacksRef.current.onStatusChange?.(finalStatus);
    
    if (isTerminalStatus(finalStatus)) {
      callbacksRef.current.onClose?.(finalStatus);
    }
    
    setAgentRunId(null);
    currentRunIdRef.current = null;
    
    invalidateQueries();
  }, [agentRunId, flushPendingChunks, invalidateQueries]);
  
  const handleBillingError = useCallback((errorMessage: string) => {
    const context = extractBillingErrorContext(errorMessage);
    
    if (optionsRef.current.handleBillingError) {
      optionsRef.current.handleBillingError(errorMessage, context.balance);
    } else {
      setError(errorMessage);
      callbacksRef.current.onError?.(errorMessage);
    }
  }, []);
  
  const checkAgentStatus = useCallback(async (runId: string): Promise<{ status: string; error?: string }> => {
    const response = await fetch(`${API_URL}/agent-runs/${runId}/status`, {
      headers: {
        'Authorization': `Bearer ${await getAuthToken()}`,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to get agent status: ${response.status}`);
    }
    
    return response.json();
  }, []);
  
  const getAuthToken = useCallback(async (): Promise<string | null> => {
    const { createClient } = await import('@/lib/supabase/client');
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token || null;
  }, []);
  
  const handleStreamMessage = useCallback((rawData: string) => {
    if (!isMountedRef.current) return;
    if (threadIdRef.current !== threadId) return;
    
    const processed = processStreamData(rawData, accumulatorRef.current);
    
    switch (processed.type) {
      case 'text_chunk':
        if (processed.content) {
          addTextChunk(processed.content, processed.message?.sequence ?? Date.now());
          callbacksRef.current.onAssistantChunk?.({ content: processed.content });
        }
        if (processed.message?.message_id) {
          callbacksRef.current.onMessage(streamMessageToUnifiedMessage(processed.message));
        }
        break;
      
      case 'reasoning_chunk':
        if (processed.content) {
          setReasoningContent(prev => prev + processed.content);
        }
        break;
      
      case 'tool_call_chunk':
        if (processed.toolCalls && processed.message) {
          const updatedMessage = createMessageWithToolCalls(processed.message, processed.toolCalls);
          updateToolCall(updatedMessage);
        }
        if (processed.content) {
          setReasoningContent(prev => prev + processed.content);
        }
        break;
      
      case 'tool_result':
        if (processed.message?.message_id) {
          callbacksRef.current.onMessage(streamMessageToUnifiedMessage(processed.message));
        }
        break;
      
      case 'message_complete':
        flushPendingChunks();
        setTextChunks([]);
        setToolCall(null);
        clearAccumulator(accumulatorRef.current);
        
        if (processed.message?.message_id) {
          callbacksRef.current.onMessage(streamMessageToUnifiedMessage(processed.message));
        }
        break;
      
      case 'status':
        if (processed.status === 'completed' || processed.status === 'stopped') {
          finalizeStream(processed.status as AgentStatus, currentRunIdRef.current);
        }
        break;
      
      case 'error':
        if (processed.errorMessage) {
          setError(processed.errorMessage);
          callbacksRef.current.onError?.(processed.errorMessage);
          optionsRef.current.showToast?.(processed.errorMessage, 'error');
        }
        break;
      
      case 'billing_error':
        if (processed.errorMessage) {
          handleBillingError(processed.errorMessage);
        }
        break;
      
      case 'tool_output_stream':
        if (processed.toolOutputStream) {
          callbacksRef.current.onToolOutputStream?.(processed.toolOutputStream);
        }
        break;
      
      case 'ping':
      case 'ignore':
        break;
    }
    
    if (statusRef.current !== 'streaming') {
      setStatus('streaming');
      callbacksRef.current.onStatusChange?.('streaming');
    }
  }, [threadId, addTextChunk, updateToolCall, flushPendingChunks, finalizeStream, handleBillingError]);
  
  handleStreamMessageRef.current = handleStreamMessage;
  
  const stableMessageHandler = useCallback((rawData: string) => {
    handleStreamMessageRef.current?.(rawData);
  }, []);
  
  const handleConnectionStateChange = useCallback((state: ConnectionState) => {
    switch (state) {
      case 'connecting':
        setStatus('connecting');
        callbacksRef.current.onStatusChange?.('connecting');
        break;
      case 'connected':
      case 'streaming':
        if (statusRef.current !== 'streaming') {
          setStatus('running');
          callbacksRef.current.onStatusChange?.('running');
        }
        break;
      case 'error':
        break;
      case 'closed':
        break;
    }
  }, []);
  
  const handleConnectionError = useCallback(async (error: Error) => {
    const runId = currentRunIdRef.current;
    if (!runId) {
      finalizeStream('error');
      return;
    }
    
    try {
      const agentStatus = await checkAgentStatus(runId);
      
      if (agentStatus.status !== 'running') {
        const finalStatus = mapBackendStatus(agentStatus.status);
        finalizeStream(finalStatus);
      } else {
        setError('Stream connection error');
        optionsRef.current.showToast?.('Stream disconnected. Worker might still be running.', 'warning');
        finalizeStream('error', runId);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isExpected = 
        errMsg.includes('not found') ||
        errMsg.includes('404') ||
        errMsg.includes('does not exist') ||
        errMsg.includes('is not running');
      
      if (isExpected) {
        finalizeStream('completed', runId);
      } else {
        finalizeStream('error', runId);
      }
    }
  }, [checkAgentStatus, finalizeStream]);
  
  const handleConnectionClose = useCallback(async () => {
    const runId = currentRunIdRef.current;
    const currentStatus = statusRef.current;
    
    if (TERMINAL_STATUSES.includes(currentStatus as typeof TERMINAL_STATUSES[number])) {
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
    
    setTimeout(async () => {
      if (!isMountedRef.current) return;
      if (currentRunIdRef.current !== runId) return;
      
      try {
        const agentStatus = await checkAgentStatus(runId);
        
        if (agentStatus.status === 'running') {
          setError('Stream closed unexpectedly while agent was running.');
          optionsRef.current.showToast?.('Stream disconnected. Worker might still be running.', 'warning');
          finalizeStream('error', runId);
        } else {
          const finalStatus = mapBackendStatus(agentStatus.status);
          finalizeStream(finalStatus, runId);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isExpected = 
          errMsg.includes('not found') ||
          errMsg.includes('404');
        
        if (isExpected) {
          finalizeStream('completed', runId);
        } else {
          finalizeStream('error', runId);
        }
      }
    }, STREAM_CONFIG.STATUS_CHECK_DELAY_MS);
  }, [checkAgentStatus, finalizeStream]);
  
  handleConnectionErrorRef.current = handleConnectionError;
  handleConnectionCloseRef.current = handleConnectionClose;
  
  const stableErrorHandler = useCallback((error: Error) => {
    handleConnectionErrorRef.current?.(error);
  }, []);
  
  const stableCloseHandler = useCallback(() => {
    handleConnectionCloseRef.current?.();
  }, []);
  
  const startStreaming = useCallback(async (runId: string) => {
    if (!isMountedRef.current) return;
    
    if (connectionRef.current) {
      connectionRef.current.destroy();
    }
    
    resetState();
    currentRunIdRef.current = runId;
    setAgentRunId(runId);
    setStatus('connecting');
    callbacksRef.current.onStatusChange?.('connecting');
    callbacksRef.current.onAssistantStart?.();
    
    const connection = new StreamConnection({
      apiUrl: API_URL,
      runId,
      getAuthToken,
      onMessage: stableMessageHandler,
      onOpen: () => {
        if (isMountedRef.current && currentRunIdRef.current === runId) {
          setStatus('running');
          callbacksRef.current.onStatusChange?.('running');
        }
      },
      onError: stableErrorHandler,
      onClose: stableCloseHandler,
      onStateChange: handleConnectionStateChange,
    });
    
    connectionRef.current = connection;
    await connection.connect();
  }, [
    resetState,
    getAuthToken,
    stableMessageHandler,
    stableErrorHandler,
    stableCloseHandler,
    handleConnectionStateChange,
  ]);
  
  const stopStreaming = useCallback(async () => {
    if (connectionRef.current) {
      connectionRef.current.destroy();
      connectionRef.current = null;
    }
    
    const runId = currentRunIdRef.current;
    if (runId) {
      try {
        const token = await getAuthToken();
        await fetch(`${API_URL}/agent-runs/${runId}/stop`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
        });
        
        optionsRef.current.showToast?.('Worker stopped.', 'success');
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('[useAgentStream] Error stopping agent:', err);
        optionsRef.current.showToast?.(`Failed to stop Worker: ${errorMessage}`, 'error');
      }
    }
    
    finalizeStream('stopped', agentRunId);
  }, [getAuthToken, agentRunId, finalizeStream]);
  
  useEffect(() => {
    return () => {
      if (connectionRef.current) {
        connectionRef.current.destroy();
        connectionRef.current = null;
      }
    };
  }, []);
  
  return {
    status,
    textContent,
    reasoningContent,
    toolCall,
    error,
    agentRunId,
    startStreaming,
    stopStreaming,
  };
}
