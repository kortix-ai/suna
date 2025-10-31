import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import EventSource from 'react-native-sse';
import type { UnifiedMessage, ParsedContent, ParsedMetadata } from '@/api/types';
import { API_URL, getAuthToken } from '@/api/config';
import { safeJsonParse } from '@/lib/utils/message-grouping';
import { chatKeys } from '@/lib/chat';

interface UseAgentStreamResult {
  status: string;
  textContent: string;
  toolCall: ParsedContent | null;
  error: string | null;
  agentRunId: string | null;
  startStreaming: (runId: string) => void;
  stopStreaming: () => Promise<void>;
}

interface AgentStreamCallbacks {
  onMessage: (message: UnifiedMessage) => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: string) => void;
  onClose?: (finalStatus: string) => void;
  onAssistantStart?: () => void;
  onAssistantChunk?: (chunk: { content: string }) => void;
}

const mapApiMessagesToUnified = (
  messagesData: any[] | null | undefined,
  currentThreadId: string,
): UnifiedMessage[] => {
  return (messagesData || [])
    .filter((msg) => msg.type !== 'status')
    .map((msg: any) => ({
      message_id: msg.message_id || null,
      thread_id: msg.thread_id || currentThreadId,
      type: (msg.type || 'system') as UnifiedMessage['type'],
      is_llm_message: Boolean(msg.is_llm_message),
      content: msg.content || '',
      metadata: msg.metadata || '{}',
      created_at: msg.created_at || new Date().toISOString(),
      updated_at: msg.updated_at || new Date().toISOString(),
      agent_id: msg.agent_id,
      agents: msg.agents,
    }));
};

export function useAgentStream(
  callbacks: AgentStreamCallbacks,
  threadId: string,
  setMessages: (messages: UnifiedMessage[]) => void,
  agentId?: string,
): UseAgentStreamResult {
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<string>('idle');
  const [textContent, setTextContent] = useState<
    { content: string; sequence?: number }[]
  >([]);
  
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingContentRef = useRef<{ content: string; sequence?: number }[]>([]);
  
  const flushPendingContent = useCallback(() => {
    if (pendingContentRef.current.length > 0) {
      const newContent = [...pendingContentRef.current];
      pendingContentRef.current = [];
      
      setTextContent((prev) => [...prev, ...newContent]);
    }
  }, []);
  
  const addContentThrottled = useCallback((content: { content: string; sequence?: number }) => {
    pendingContentRef.current.push(content);
    
    if (throttleRef.current) {
      clearTimeout(throttleRef.current);
    }
    
    throttleRef.current = setTimeout(flushPendingContent, 16);
  }, [flushPendingContent]);

  const [toolCall, setToolCall] = useState<ParsedContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);

  const streamCleanupRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const currentRunIdRef = useRef<string | null>(null);
  const threadIdRef = useRef(threadId);
  const setMessagesRef = useRef(setMessages);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef<number>(0);
  const startStreamingRef = useRef<((runId: string) => void) | null>(null);

  const orderedTextContent = useMemo(() => {
    if (textContent.length === 0) return '';
    
    const sorted = textContent.slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    let result = '';
    for (let i = 0; i < sorted.length; i++) {
      result += sorted[i].content;
    }
    return result;
  }, [textContent]);

  const statusRef = useRef(status);
  const agentRunIdRef = useRef(agentRunId);
  const textContentRef = useRef(textContent);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    agentRunIdRef.current = agentRunId;
  }, [agentRunId]);

  useEffect(() => {
    textContentRef.current = textContent;
  }, [textContent]);

  useEffect(() => {
    const previousThreadId = threadIdRef.current;
    const cleanup = streamCleanupRef.current;
    const isRealThreadSwitch = 
      previousThreadId && 
      threadId && 
      previousThreadId !== threadId &&
      cleanup;
    
    if (isRealThreadSwitch && cleanup) {
      console.log(`[useAgentStream] Thread changed from ${previousThreadId} to ${threadId}, cleaning up stream`);
      cleanup();
      streamCleanupRef.current = null;
      setStatus('idle');
      setTextContent([]);
      setToolCall(null);
      setAgentRunId(null);
      currentRunIdRef.current = null;
      
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      retryCountRef.current = 0;
    }
    threadIdRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    setMessagesRef.current = setMessages;
  }, [setMessages]);

  const mapAgentStatus = (backendStatus: string): string => {
    switch (backendStatus) {
      case 'completed':
        return 'completed';
      case 'stopped':
        return 'stopped';
      case 'failed':
        return 'failed';
      default:
        return 'error';
    }
  };

  const updateStatus = useCallback(
    (newStatus: string) => {
      if (isMountedRef.current) {
        setStatus(newStatus);
        callbacks.onStatusChange?.(newStatus);
        if (newStatus === 'error' && error) {
          callbacks.onError?.(error);
        }
        if (
          [
            'completed',
            'stopped',
            'failed',
            'error',
            'agent_not_running',
          ].includes(newStatus)
        ) {
          callbacks.onClose?.(newStatus);
        }
      }
    },
    [callbacks, error],
  );

  const finalizeStream = useCallback(
    (finalStatus: string, runId: string | null = agentRunId) => {
      if (!isMountedRef.current) return;

      console.log(
        `[useAgentStream] Finalizing stream with status: ${finalStatus}, runId: ${runId}`,
      );

      const currentThreadId = threadIdRef.current;
      const currentSetMessages = setMessagesRef.current;

      if (
        runId &&
        currentRunIdRef.current &&
        currentRunIdRef.current !== runId
      ) {
        console.log(
          `[useAgentStream] Ignoring finalization for old run ID ${runId}, current is ${currentRunIdRef.current}`,
        );
        return;
      }

      if (streamCleanupRef.current) {
        streamCleanupRef.current();
        streamCleanupRef.current = null;
      }

      setTextContent([]);
      setToolCall(null);

      updateStatus(finalStatus);
      setAgentRunId(null);
      currentRunIdRef.current = null;

      queryClient.invalidateQueries({ 
        queryKey: ['active-agent-runs'],
      });

      if (agentId) {
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
      }

      if (
        runId &&
        (finalStatus === 'completed' ||
          finalStatus === 'stopped' ||
          finalStatus === 'agent_not_running')
      ) {
        getAgentStatus(runId).catch((err) => {});
      }
    },
    [agentRunId, updateStatus, agentId, queryClient],
  );

  const handleStreamMessage = useCallback(
    (rawData: string) => {
      if (!isMountedRef.current) return;

      let processedData = rawData;
      if (processedData.startsWith('data: ')) {
        processedData = processedData.substring(6).trim();
      }
      if (!processedData) return;

      if (
        processedData ===
        '{"type": "status", "status": "completed", "message": "Agent run completed successfully"}'
      ) {
        finalizeStream('completed', currentRunIdRef.current);
        return;
      }
      if (
        processedData.includes('Run data not available for streaming') ||
        processedData.includes('Stream ended with status: completed')
      ) {
        finalizeStream('completed', currentRunIdRef.current);
        return;
      }

      try {
        const jsonData = JSON.parse(processedData);
        if (jsonData.status === 'error') {
          console.error(
            '[useAgentStream] Received error status message:',
            jsonData,
          );
          const errorMessage = jsonData.message || 'Unknown error occurred';
          setError(errorMessage);
          callbacks.onError?.(errorMessage);
          return;
        }
      } catch (jsonError) {
      }

      const message = safeJsonParse(
        processedData,
        null,
      ) as UnifiedMessage | null;
      if (!message) {
        console.warn(
          '[useAgentStream] Failed to parse streamed message:',
          processedData,
        );
        return;
      }

      const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
      const parsedMetadata = safeJsonParse<ParsedMetadata>(
        message.metadata,
        {},
      );

      if (status !== 'streaming') updateStatus('streaming');

      switch (message.type) {
        case 'assistant':
          if (
            parsedMetadata.stream_status === 'chunk' &&
            parsedContent.content
          ) {
            if (retryCountRef.current > 0) {
              console.log('[useAgentStream] Successfully connected, resetting retry counter');
              retryCountRef.current = 0;
            }
            addContentThrottled({
              sequence: message.sequence,
              content: parsedContent.content,
            });
            callbacks.onAssistantChunk?.({ content: parsedContent.content });
          } else if (parsedMetadata.stream_status === 'complete') {
            flushPendingContent();
            
            setTextContent([]);
            setToolCall(null);
            if (message.message_id) callbacks.onMessage(message);
          } else if (!parsedMetadata.stream_status) {
            callbacks.onAssistantStart?.();
            if (message.message_id) callbacks.onMessage(message);
          }
          break;
        case 'tool':
          setToolCall(null);
          if (message.message_id) callbacks.onMessage(message);
          break;
        case 'status':
          switch (parsedContent.status_type) {
            case 'tool_started':
              setToolCall({
                role: 'assistant',
                status_type: 'tool_started',
                name: parsedContent.function_name,
                arguments: parsedContent.arguments,
                xml_tag_name: parsedContent.xml_tag_name,
                tool_index: parsedContent.tool_index,
              });
              break;
            case 'tool_completed':
            case 'tool_failed':
            case 'tool_error':
              if (toolCall?.tool_index === parsedContent.tool_index) {
                setToolCall(null);
              }
              break;
            case 'finish':
              break;
            case 'error':
              setError(parsedContent.message || 'Agent run failed');
              finalizeStream('error', currentRunIdRef.current);
              break;
            default:
              break;
          }
          break;
        case 'llm_response_end':
        case 'llm_response_start':
          break;
        case 'user':
        case 'system':
          if (message.message_id) callbacks.onMessage(message);
          break;
        default:
          console.warn(
            '[useAgentStream] Unhandled message type:',
            message.type,
          );
      }
    },
    [
      status,
      toolCall,
      callbacks,
      finalizeStream,
      updateStatus,
      addContentThrottled,
      flushPendingContent,
    ],
  );

  const handleStreamError = useCallback(
    (err: any) => {
      if (!isMountedRef.current) return;

      let errorMessage = 'Unknown streaming error';
      let is404 = false;
      
      if (typeof err === 'string') {
        errorMessage = err;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      } else if (err && typeof err === 'object') {
        if (err.xhrStatus === 404) {
          is404 = true;
          errorMessage = 'Stream endpoint not found (404) - run may still be initializing';
        } else if (err.message) {
          errorMessage = err.message;
        } else if (err.type === 'error') {
          errorMessage = 'Stream connection error';
        }
      }

      const lower = errorMessage.toLowerCase();
      const isExpected =
        is404 ||
        lower.includes('not found') || 
        lower.includes('not running') ||
        lower.includes('404');

      const runId = currentRunIdRef.current;
      
      if (isExpected) {
        console.info('[useAgentStream] Stream endpoint not ready (expected for new runs):', errorMessage);
        
        if (is404 && runId) {
          console.log(`[useAgentStream] Current retry count before increment: ${retryCountRef.current}`);
          
          if (retryCountRef.current < 3) {
            retryCountRef.current += 1;
            const retryDelay = retryCountRef.current * 1000;
            console.log(`[useAgentStream] Scheduling retry ${retryCountRef.current}/3 in ${retryDelay}ms for run ${runId}`);
            
            if (streamCleanupRef.current) {
              streamCleanupRef.current();
              streamCleanupRef.current = null;
            }
            
            retryTimeoutRef.current = setTimeout(() => {
              if (isMountedRef.current && currentRunIdRef.current === runId && startStreamingRef.current) {
                console.log(`[useAgentStream] Retrying stream connection for run ${runId}, retry count at execution: ${retryCountRef.current}`);
                startStreamingRef.current(runId);
              }
            }, retryDelay);
          } else {
            console.warn(`[useAgentStream] Max retries (3) reached for run ${runId}, giving up`);
            finalizeStream('error', runId);
          }
        }
        return;
      }
      
      console.error('[useAgentStream] Streaming error:', errorMessage, err);
      setError(errorMessage);

      if (!runId) {
        console.warn(
          '[useAgentStream] Stream error occurred but no agentRunId is active.',
        );
        finalizeStream('error');
        return;
      }
    },
    [finalizeStream],
  );

  const handleStreamClose = useCallback(() => {
    if (!isMountedRef.current) return;

    const runId = currentRunIdRef.current;
    console.log(
      `[useAgentStream] Stream closed for run ID: ${runId}, status: ${status}`,
    );

    if (!runId) {
      console.warn('[useAgentStream] Stream closed but no active agentRunId.');
      if (status === 'streaming' || status === 'connecting') {
        finalizeStream('error');
      } else if (
        status !== 'idle' &&
        status !== 'completed' &&
        status !== 'stopped' &&
        status !== 'agent_not_running'
      ) {
        finalizeStream('idle');
      }
      return;
    }

    console.log(`[useAgentStream] Checking final status for run ID: ${runId}`);
    getAgentStatus(runId)
      .then((agentStatus) => {
        if (!isMountedRef.current) return;

        if (currentRunIdRef.current !== runId) {
          console.log(
            `[useAgentStream] Run ID changed during status check in handleStreamClose, ignoring`,
          );
          return;
        }

        console.log(
          `[useAgentStream] Final status for run ID ${runId}: ${agentStatus.status}`,
        );

        if (agentStatus.status === 'running') {
          setError('Stream closed unexpectedly while agent was running.');
          finalizeStream('error', runId);
        } else {
          const finalStatus = mapAgentStatus(agentStatus.status);
          finalizeStream(finalStatus, runId);
        }
      })
      .catch((err) => {
        if (!isMountedRef.current) return;

        if (currentRunIdRef.current !== runId) {
          console.log(
            `[useAgentStream] Run ID changed during error handling in handleStreamClose, ignoring`,
          );
          return;
        }

        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(
          `[useAgentStream] Error checking agent status for ${runId} after stream close: ${errorMessage}`,
        );

        const isNotFoundError =
          errorMessage.includes('not found') ||
          errorMessage.includes('404') ||
          errorMessage.includes('does not exist');

        if (isNotFoundError) {
          finalizeStream('agent_not_running', runId);
        } else {
          finalizeStream('error', runId);
        }
      });
  }, [status, finalizeStream]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;

      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
      
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      
      flushPendingContent();
    };
  }, [flushPendingContent]);

  const startStreaming = useCallback(
    async (runId: string) => {
      if (!isMountedRef.current) return;

      console.log(`[useAgentStream] Starting stream for run ID: ${runId}, current retry count: ${retryCountRef.current}`);

      const previousCleanup = streamCleanupRef.current;
      const previousRunId = currentRunIdRef.current;
      
      currentRunIdRef.current = runId;
      
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }

      try {
        if (!isMountedRef.current) return;

        if (previousCleanup && previousRunId !== runId) {
          console.log(`[useAgentStream] Cleaning up previous stream ${previousRunId} to start new stream ${runId}, resetting retry count`);
          retryCountRef.current = 0;
          previousCleanup();
          streamCleanupRef.current = null;
        }

        setTextContent([]);
        setToolCall(null);
        setError(null);
        updateStatus('connecting');
        setAgentRunId(runId);

        const token = await getAuthToken();
        const url = `${API_URL}/agent-run/${runId}/stream?token=${token}`;
        
        const eventSource = new EventSource(url);

        eventSource.addEventListener('message', (event: any) => {
          if (threadIdRef.current !== threadId) return;
          if (currentRunIdRef.current !== runId) return;
          handleStreamMessage(event.data);
        });

        eventSource.addEventListener('error', (event: any) => {
          if (threadIdRef.current !== threadId) return;
          if (currentRunIdRef.current !== runId) return;
          handleStreamError(event);
        });

        eventSource.addEventListener('close', () => {
          if (threadIdRef.current !== threadId) return;
          if (currentRunIdRef.current !== runId) return;
          handleStreamClose();
        });

        const cleanup = () => {
          eventSource.removeAllEventListeners();
          eventSource.close();
        };

        streamCleanupRef.current = cleanup;
        console.log(
          `[useAgentStream] Stream created successfully for run ID: ${runId}`,
        );

        setTimeout(async () => {
          if (!isMountedRef.current) return;
          if (currentRunIdRef.current !== runId) return;
          if (statusRef.current === 'streaming') return;
          try {
            const latest = await getAgentStatus(runId);
            if (!isMountedRef.current) return;
            if (currentRunIdRef.current !== runId) return;
            if (latest.status !== 'running') {
              finalizeStream(
                mapAgentStatus(latest.status) || 'agent_not_running',
                runId,
              );
            }
          } catch {
          }
        }, 1500);
      } catch (err) {
        if (!isMountedRef.current) return;

        if (currentRunIdRef.current !== runId) {
          console.log(
            `[useAgentStream] Error occurred for old run ID ${runId}, ignoring`,
          );
          return;
        }

        const errorMessage = err instanceof Error ? err.message : String(err);
        const lower = errorMessage.toLowerCase();
        const isExpected =
          lower.includes('not found') ||
          lower.includes('404') ||
          lower.includes('does not exist') ||
          lower.includes('not running');

        if (isExpected) {
          console.info(
            `[useAgentStream] Stream not started for ${runId}: ${errorMessage}`,
          );
          
          if (!previousRunId || previousRunId === runId) {
            finalizeStream('agent_not_running', runId);
          } else {
            console.log(`[useAgentStream] Keeping previous stream ${previousRunId} active since new stream ${runId} failed to start`);
          }
        } else {
          console.error(
            `[useAgentStream] Error initiating stream for ${runId}: ${errorMessage}`,
          );
          setError(errorMessage);
          
          if (!previousRunId || previousRunId === runId) {
            finalizeStream('error', runId);
          } else {
            console.log(`[useAgentStream] Keeping previous stream ${previousRunId} active despite error starting new stream ${runId}`);
            currentRunIdRef.current = previousRunId;
            setAgentRunId(previousRunId);
          }
        }
      }
    },
    [
      threadId,
      updateStatus,
      finalizeStream,
      handleStreamMessage,
      handleStreamError,
      handleStreamClose,
    ],
  );

  const stopStreaming = useCallback(async () => {
    if (!isMountedRef.current || !agentRunId) return;

    const runIdToStop = agentRunId;

    finalizeStream('stopped', runIdToStop);

    try {
      const token = await getAuthToken();
      await fetch(`${API_URL}/agent-runs/${runIdToStop}/stop`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[useAgentStream] Error sending stop request for ${runIdToStop}: ${errorMessage}`,
      );
    }
  }, [agentRunId, finalizeStream]);
  
  useEffect(() => {
    startStreamingRef.current = startStreaming;
  }, [startStreaming]);

  return {
    status,
    textContent: orderedTextContent,
    toolCall,
    error,
    agentRunId,
    startStreaming,
    stopStreaming,
  };
}

async function getAgentStatus(runId: string): Promise<{ status: string }> {
  const token = await getAuthToken();
  const response = await fetch(`${API_URL}/agent-runs/${runId}/status`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get agent status: ${response.status}`);
  }
  
  return response.json();
}

