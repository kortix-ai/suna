import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  streamAgent,
  getAgentStatus,
  stopAgent,
} from '@/lib/api/agents';
import { toast } from 'sonner';
import {
  UnifiedMessage,
  ParsedContent,
  ParsedMetadata,
} from '@/components/thread/types';
import { safeJsonParse } from '@/components/thread/utils';
import { agentKeys } from '@/hooks/agents/keys';
import { composioKeys } from '@/hooks/composio/keys';
import { knowledgeBaseKeys } from '@/hooks/knowledge-base/keys';
import { fileQueryKeys } from '@/hooks/files/use-file-queries';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { accountStateKeys } from '@/hooks/billing';

// Define the structure returned by the hook
export interface UseAgentStreamResult {
  status: string;
  textContent: string;
  toolCall: UnifiedMessage | null; // UnifiedMessage with metadata.tool_calls
  error: string | null;
  agentRunId: string | null;
  startStreaming: (runId: string) => void;
  stopStreaming: () => Promise<void>;
}

// Define the callbacks the hook consumer can provide
export interface AgentStreamCallbacks {
  onMessage: (message: UnifiedMessage) => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: string) => void;
  onClose?: (finalStatus: string) => void;
  onAssistantStart?: () => void;
  onAssistantChunk?: (chunk: { content: string }) => void;
  onToolCallChunk?: (message: UnifiedMessage) => void;
}

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
  
  // Throttled state updates for smoother streaming
  const throttleRef = useRef<NodeJS.Timeout | null>(null);
  const pendingContentRef = useRef<{ content: string; sequence?: number }[]>([]);
  
  // Throttled content update function for smoother streaming
  const flushPendingContent = useCallback(() => {
    if (pendingContentRef.current.length > 0) {
      // Sort chunks by sequence before adding to state
      const sortedContent = pendingContentRef.current.slice().sort((a, b) => {
        const aSeq = a.sequence ?? 0;
        const bSeq = b.sequence ?? 0;
        return aSeq - bSeq;
      });
      pendingContentRef.current = [];
      
      React.startTransition(() => {
        setTextContent((prev) => {
          // Combine with existing content and sort all together
          const combined = [...prev, ...sortedContent];
          return combined.sort((a, b) => {
            const aSeq = a.sequence ?? 0;
            const bSeq = b.sequence ?? 0;
            return aSeq - bSeq;
          });
        });
      });
    }
  }, []);
  
  const addContentThrottled = useCallback((content: { content: string; sequence?: number }) => {
    pendingContentRef.current.push(content);
    
    // Clear existing throttle
    if (throttleRef.current) {
      clearTimeout(throttleRef.current);
    }
    
    // Set new throttle for smooth updates (16ms ≈ 60fps)
    throttleRef.current = setTimeout(flushPendingContent, 16);
  }, [flushPendingContent]);
  
  const [toolCall, setToolCall] = useState<UnifiedMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);

  const streamCleanupRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const currentRunIdRef = useRef<string | null>(null);
  const threadIdRef = useRef(threadId);
  const setMessagesRef = useRef(setMessages);

  const orderedTextContent = useMemo(() => {
    if (textContent.length === 0) return '';
    
    // Only sort if sequences are out of order (optimization)
    let needsSorting = false;
    for (let i = 1; i < textContent.length; i++) {
      const prevSeq = textContent[i - 1].sequence ?? 0;
      const currSeq = textContent[i].sequence ?? 0;
      if (currSeq < prevSeq) {
        needsSorting = true;
        break;
      }
    }
    
    // If already sorted, just concatenate
    if (!needsSorting) {
      let result = '';
      for (let i = 0; i < textContent.length; i++) {
        result += textContent[i].content;
      }
      return result;
    }
    
    // Only sort if necessary
    const sorted = textContent.slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    let result = '';
    for (let i = 0; i < sorted.length; i++) {
      result += sorted[i].content;
    }
    return result;
  }, [textContent]);

  // Refs to capture current state for persistence
  const statusRef = useRef(status);
  const agentRunIdRef = useRef(agentRunId);
  const textContentRef = useRef(textContent);

  // Update refs whenever state changes
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    agentRunIdRef.current = agentRunId;
  }, [agentRunId]);

  useEffect(() => {
    textContentRef.current = textContent;
  }, [textContent]);

  // On thread change, ensure any existing stream is cleaned up
  useEffect(() => {
    const previousThreadId = threadIdRef.current;
    if (
      previousThreadId &&
      previousThreadId !== threadId &&
      streamCleanupRef.current
    ) {
      streamCleanupRef.current();
      streamCleanupRef.current = null;
      setStatus('idle');
      setTextContent([]);
      setToolCall(null);
      setAgentRunId(null);
      currentRunIdRef.current = null;
    }
    threadIdRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    setMessagesRef.current = setMessages;
  }, [setMessages]);

  // Helper function to map backend status to frontend status string
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

  // Internal function to update status and notify consumer
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

  // Function to handle finalization of a stream
  const finalizeStream = useCallback(
    (finalStatus: string, runId: string | null = agentRunId) => {
      if (!isMountedRef.current) return;

      const currentThreadId = threadIdRef.current;
      const currentSetMessages = setMessagesRef.current;

      // Only finalize if this is for the current run ID or if no specific run ID is provided
      if (
        runId &&
        currentRunIdRef.current &&
        currentRunIdRef.current !== runId
      ) {
        return;
      }

      if (streamCleanupRef.current) {
        streamCleanupRef.current();
        streamCleanupRef.current = null;
      }

      // Reset streaming-specific state
      setTextContent([]);
      setToolCall(null);

      // Update status and clear run ID
      updateStatus(finalStatus);
      setAgentRunId(null);
      currentRunIdRef.current = null;

      queryClient.invalidateQueries({ 
        queryKey: fileQueryKeys.all,
      });

      queryClient.invalidateQueries({ 
        queryKey: ['active-agent-runs'],
      });

      // Invalidate account state after agent run completes (credits may have been deducted)
      queryClient.invalidateQueries({ 
        queryKey: accountStateKeys.all,
      });

      if (agentId) {
        // Core agent data
        queryClient.invalidateQueries({ queryKey: agentKeys.all });
        queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
        queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
        queryClient.invalidateQueries({ queryKey: agentKeys.details() });
        
        // Agent tools and integrations
        queryClient.invalidateQueries({ queryKey: ['agent-tools', agentId] });
        queryClient.invalidateQueries({ queryKey: ['agent-tools'] });
        
        // MCP configurations
        queryClient.invalidateQueries({ queryKey: ['custom-mcp-tools', agentId] });
        queryClient.invalidateQueries({ queryKey: ['custom-mcp-tools'] });
        queryClient.invalidateQueries({ queryKey: composioKeys.mcpServers() });
        queryClient.invalidateQueries({ queryKey: composioKeys.profiles.all() });
        queryClient.invalidateQueries({ queryKey: composioKeys.profiles.credentials() });
        
        // Triggers
        queryClient.invalidateQueries({ queryKey: ['triggers', agentId] });
        queryClient.invalidateQueries({ queryKey: ['triggers'] });
        
        // Knowledge base
        queryClient.invalidateQueries({ queryKey: knowledgeBaseKeys.agent(agentId) });
        queryClient.invalidateQueries({ queryKey: knowledgeBaseKeys.all });
        
        queryClient.invalidateQueries({ queryKey: ['versions'] });
        queryClient.invalidateQueries({ queryKey: ['versions', 'list'] });
        queryClient.invalidateQueries({ queryKey: ['versions', 'list', agentId] });
        queryClient.invalidateQueries({ queryKey: ['versions', 'detail'] });
        queryClient.invalidateQueries({ 
          queryKey: ['versions', 'detail'], 
          predicate: (query) => {
            return query.queryKey.includes(agentId);
          }
        });
        
        // Invalidate any version store cache
        queryClient.invalidateQueries({ queryKey: ['version-store'] });
        
        // Force refetch of agent configuration data
        queryClient.refetchQueries({ queryKey: agentKeys.detail(agentId) });
        queryClient.refetchQueries({ queryKey: ['versions', 'list', agentId] });
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

  // Stream message handler
  const handleStreamMessage = useCallback(
    (rawData: string) => {
      if (!isMountedRef.current) return;

      let processedData = rawData;
      if (processedData.startsWith('data: ')) {
        processedData = processedData.substring(6).trim();
      }
      if (!processedData) return;

      // Early exit for non-JSON completion messages
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

      // Check for error messages first
      try {
        const jsonData = JSON.parse(processedData);
        if (jsonData.status === 'error') {
          console.error(
            '[useAgentStream] Received error status message:',
            jsonData,
          );
          const errorMessage = jsonData.message || 'Unknown error occurred';
          const messageLower = errorMessage.toLowerCase();
          
          // Check if this is a billing error
          const isBillingError = 
            messageLower.includes('insufficient credits') ||
            messageLower.includes('credit') ||
            messageLower.includes('balance') ||
            messageLower.includes('out of credits') ||
            messageLower.includes('no credits') ||
            messageLower.includes('billing check failed');
          
          if (isBillingError) {
            React.startTransition(() => {
              setError(errorMessage);
            });
            callbacks.onError?.(errorMessage);
            
            const isCreditsExhausted = 
              messageLower.includes('insufficient credits') ||
              messageLower.includes('out of credits') ||
              messageLower.includes('no credits') ||
              messageLower.includes('balance');
            
            const alertTitle = isCreditsExhausted 
              ? 'You ran out of credits. Upgrade now.'
              : 'Billing check failed. Please upgrade to continue.';
            
            usePricingModalStore.getState().openPricingModal({ 
              isAlert: true, 
              alertTitle 
            });
            return;
          }
          
          React.startTransition(() => {
            setError(errorMessage);
          });
          toast.error(errorMessage, { duration: 15000 });
          callbacks.onError?.(errorMessage);
          return;
        }
        // Check for stopped status with billing error message
        if (jsonData.status === 'stopped' && jsonData.message) {
          const message = jsonData.message.toLowerCase();
          const isBillingError = 
            message.includes('insufficient credits') ||
            message.includes('credit') ||
            message.includes('balance') ||
            message.includes('out of credits') ||
            message.includes('no credits') ||
            message.includes('billing check failed');
          
          if (isBillingError) {
            console.error(
              '[useAgentStream] Agent stopped due to billing error:',
              jsonData.message,
            );
            React.startTransition(() => {
              setError(jsonData.message);
            });
            callbacks.onError?.(jsonData.message);
            
            const isCreditsExhausted = 
              message.includes('insufficient credits') ||
              message.includes('out of credits') ||
              message.includes('no credits') ||
              message.includes('balance');
            
            const alertTitle = isCreditsExhausted 
              ? 'You ran out of credits. Upgrade now.'
              : 'Billing check failed. Please upgrade to continue.';
            
            usePricingModalStore.getState().openPricingModal({ 
              isAlert: true, 
              alertTitle 
            });
            
            finalizeStream('stopped', currentRunIdRef.current);
            return;
          }
        }
      } catch (jsonError) {
        // Not JSON or could not parse as JSON, continue processing
      }

      // Process JSON messages
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

      // Update status to streaming if we receive a valid message
      if (statusRef.current !== 'streaming') {
        React.startTransition(() => {
          updateStatus('streaming');
        });
      }

      switch (message.type) {
        case 'assistant':
          if (parsedMetadata.stream_status === 'tool_call_chunk') {
            // Handle tool call chunks - extract from metadata.tool_calls
            const toolCalls = parsedMetadata.tool_calls || [];
            if (toolCalls.length > 0) {
              // Set toolCall state with the UnifiedMessage
              setToolCall(message);
              // Call the callback with the full message (includes all tool calls in metadata)
              callbacks.onToolCallChunk?.(message);
            }
          } else if (
            parsedMetadata.stream_status === 'chunk' &&
            parsedContent.content
          ) {
            // Use throttled approach for smoother streaming
            addContentThrottled({
              sequence: message.sequence,
              content: parsedContent.content,
            });
            callbacks.onAssistantChunk?.({ content: parsedContent.content });
          } else if (parsedMetadata.stream_status === 'complete') {
            // Flush any pending content before completing
            flushPendingContent();
            
            React.startTransition(() => {
              setTextContent([]);
              setToolCall(null);
            });
            if (message.message_id) callbacks.onMessage(message);
          } else if (!parsedMetadata.stream_status) {
            // Handle non-chunked assistant messages if needed
            callbacks.onAssistantStart?.();
            if (message.message_id) callbacks.onMessage(message);
          }
          break;
        case 'tool':
          React.startTransition(() => {
            setToolCall(null); // Clear any streaming tool call
          });
          if (message.message_id) callbacks.onMessage(message);
          break;
        case 'status':
          switch (parsedContent.status_type) {
            case 'tool_completed':
            case 'tool_failed':
            case 'tool_error':
              // Clear streaming tool call when tool completes/fails
              React.startTransition(() => {
                setToolCall(null);
              });
              break;
            case 'finish':
              // Optional: Handle finish reasons like 'xml_tool_limit_reached'
              // Don't finalize here, wait for thread_run_end or completion message
              break;
            case 'error':
              React.startTransition(() => {
                setError(parsedContent.message || 'Agent run failed');
              });
              finalizeStream('error', currentRunIdRef.current);
              break;
            default:
              break;
          }
          break;
        case 'llm_response_end':
        case 'llm_response_start':
          // llm_response_end and llm_response_start messages are ignored (metadata only)
          break;
        case 'user':
        case 'system':
          // Handle other message types if necessary
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
    (err: Error | string | Event) => {
      if (!isMountedRef.current) return;

      // Extract error message
      let errorMessage = 'Unknown streaming error';
      if (typeof err === 'string') {
        errorMessage = err;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      } else if (err instanceof Event && err.type === 'error') {
        errorMessage = 'Stream connection error';
      }

      const lower = errorMessage.toLowerCase();
      const isExpected =
        lower.includes('not found') || lower.includes('not running');

      if (!isExpected) {
        console.error('[useAgentStream] Streaming error:', errorMessage, err);
        setError(errorMessage);
        toast.error(errorMessage, { duration: 15000 });
      }

      const runId = currentRunIdRef.current;
      if (!runId) {
        finalizeStream('error');
        return;
      }
    },
    [finalizeStream],
  );

  const handleStreamClose = useCallback(() => {
    if (!isMountedRef.current) return;

    const runId = currentRunIdRef.current;

    if (!runId) {
      // If status was streaming, something went wrong, finalize as error
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

    // Immediately check the agent status when the stream closes unexpectedly
    getAgentStatus(runId)
      .then((agentStatus) => {
        if (!isMountedRef.current) return;

        // Check if this is still the current run ID
        if (currentRunIdRef.current !== runId) {
          return;
        }

        if (agentStatus.status === 'running') {
          setError('Stream closed unexpectedly while agent was running.');
          finalizeStream('error', runId);
          toast.warning('Stream disconnected. Agent might still be running.');
        } else if (agentStatus.status === 'stopped') {
          // Check if agent stopped due to billing error
          const errorMessage = agentStatus.error || '';
          const lower = errorMessage.toLowerCase();
          const isBillingError = 
            lower.includes('insufficient credits') ||
            lower.includes('credit') ||
            lower.includes('balance') ||
            lower.includes('out of credits') ||
            lower.includes('no credits') ||
            lower.includes('billing check failed');
          
          if (isBillingError && errorMessage) {
            console.error(
              `[useAgentStream] Agent stopped due to billing error: ${errorMessage}`,
            );
            setError(errorMessage);
            callbacks.onError?.(errorMessage);
            
            const isCreditsExhausted = 
              lower.includes('insufficient credits') ||
              lower.includes('out of credits') ||
              lower.includes('no credits') ||
              lower.includes('balance');
            
            const alertTitle = isCreditsExhausted 
              ? 'You ran out of credits. Upgrade now.'
              : 'Billing check failed. Please upgrade to continue.';
            
            usePricingModalStore.getState().openPricingModal({ 
              isAlert: true, 
              alertTitle 
            });
          }
          
          const finalStatus = mapAgentStatus(agentStatus.status);
          finalizeStream(finalStatus, runId);
        } else {
          const finalStatus = mapAgentStatus(agentStatus.status);
          finalizeStream(finalStatus, runId);
        }
      })
      .catch((err) => {
        if (!isMountedRef.current) return;

        // Check if this is still the current run ID
        if (currentRunIdRef.current !== runId) {
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
  }, [status, finalizeStream, callbacks]);

  // Effect to manage the stream lifecycle
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;

      // Clean up throttle timeout
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
      
      // Flush any remaining pending content
      flushPendingContent();
    };
  }, [flushPendingContent]);

  // Public Functions
  const startStreaming = useCallback(
    async (runId: string) => {
      if (!isMountedRef.current) return;

      // Store previous stream cleanup for potential restoration
      const previousCleanup = streamCleanupRef.current;
      const previousRunId = currentRunIdRef.current;

      try {
        // Verify agent is running BEFORE cleaning up previous stream
        const agentStatus = await getAgentStatus(runId);
        if (!isMountedRef.current) return;

        if (agentStatus.status !== 'running') {
          const final =
            agentStatus.status === 'completed' ||
            agentStatus.status === 'stopped'
              ? mapAgentStatus(agentStatus.status)
              : 'agent_not_running';
          
          if (!previousRunId || previousRunId === runId) {
            finalizeStream(final, runId);
          }
          return;
        }

        // New agent is running, now it's safe to clean up previous stream
        if (previousCleanup && previousRunId !== runId) {
          previousCleanup();
          streamCleanupRef.current = null;
        }

        // Reset state for the new stream
        setTextContent([]);
        setToolCall(null);
        setError(null);
        updateStatus('connecting');
        setAgentRunId(runId);
        currentRunIdRef.current = runId;

        // Agent is running, proceed to create the stream
        const cleanup = streamAgent(runId, {
          onMessage: (data) => {
            if (threadIdRef.current !== threadId) return;
            if (currentRunIdRef.current !== runId) return;
            handleStreamMessage(data);
          },
          onError: (err) => {
            if (threadIdRef.current !== threadId) return;
            if (currentRunIdRef.current !== runId) return;
            handleStreamError(err);
          },
          onClose: () => {
            if (threadIdRef.current !== threadId) return;
            if (currentRunIdRef.current !== runId) return;
            handleStreamClose();
          },
        });
        streamCleanupRef.current = cleanup;

        // Status will be updated to 'streaming' by the first message received
        // If no message arrives shortly, verify liveness again
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
            // ignore
          }
        }, 1500);
      } catch (err) {
        if (!isMountedRef.current) return;

        // Only handle error if this is still the current run ID
        if (currentRunIdRef.current !== runId) {
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
          if (!previousRunId || previousRunId === runId) {
            finalizeStream('agent_not_running', runId);
          }
        } else {
          console.error(
            `[useAgentStream] Error initiating stream for ${runId}: ${errorMessage}`,
          );
          setError(errorMessage);
          
          if (!previousRunId || previousRunId === runId) {
            finalizeStream('error', runId);
          } else {
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

    // Immediately update status and clean up stream
    finalizeStream('stopped', runIdToStop);

    try {
      await stopAgent(runIdToStop);
      toast.success('Agent stopped.');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[useAgentStream] Error sending stop request for ${runIdToStop}: ${errorMessage}`,
      );
      toast.error(`Failed to stop agent: ${errorMessage}`);
    }
  }, [agentRunId, finalizeStream]);

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

