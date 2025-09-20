import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  streamAgent,
  getAgentStatus,
  stopAgent,
  AgentRun,
  getMessages,
} from '@/lib/api';
import { toast } from 'sonner';
import {
  UnifiedMessage,
  ParsedContent,
  ParsedMetadata,
} from '@/components/thread/types';
import { safeJsonParse } from '@/components/thread/utils';
import { agentKeys } from '@/hooks/react-query/agents/keys';
import { composioKeys } from '@/hooks/react-query/composio/keys';
import { workflowKeys } from '@/hooks/react-query/agents/workflow-keys';
import { knowledgeBaseKeys } from '@/hooks/react-query/knowledge-base/keys';
import { fileQueryKeys } from '@/hooks/react-query/files/use-file-queries';

interface ApiMessageType {
  message_id?: string;
  thread_id?: string;
  type: string;
  is_llm_message?: boolean;
  content: string;
  metadata?: string;
  created_at?: string;
  updated_at?: string;
  agent_id?: string;
  agents?: {
    name: string;
  };
}

// Define the structure returned by the hook
export interface UseAgentStreamResult {
  status: string;
  textContent: string;
  toolCall: ParsedContent | null;
  error: string | null;
  agentRunId: string | null; // Expose the currently managed agentRunId
  startStreaming: (runId: string) => void;
  stopStreaming: () => Promise<void>;
}

// Define the callbacks the hook consumer can provide
export interface AgentStreamCallbacks {
  onMessage: (message: UnifiedMessage) => void; // Callback for complete messages
  onStatusChange?: (status: string) => void; // Optional: Notify on internal status changes
  onError?: (error: string) => void; // Optional: Notify on errors
  onClose?: (finalStatus: string) => void; // Optional: Notify when streaming definitively ends
  onAssistantStart?: () => void; // Optional: Notify when assistant starts streaming
  onAssistantChunk?: (chunk: { content: string }) => void; // Optional: Notify on each assistant message chunk
}

// Helper function to map API messages to UnifiedMessages
const mapApiMessagesToUnified = (
  messagesData: ApiMessageType[] | null | undefined,
  currentThreadId: string,
): UnifiedMessage[] => {
  return (messagesData || [])
    .filter((msg) => msg.type !== 'status')
    .map((msg: ApiMessageType) => ({
      message_id: msg.message_id || null,
      thread_id: msg.thread_id || currentThreadId,
      type: (msg.type || 'system') as UnifiedMessage['type'],
      is_llm_message: Boolean(msg.is_llm_message),
      content: msg.content || '',
      metadata: msg.metadata || '{}',
      created_at: msg.created_at || new Date().toISOString(),
      updated_at: msg.updated_at || new Date().toISOString(),
      agent_id: (msg as any).agent_id,
      agents: (msg as any).agents,
    }));
};

export function useAgentStream(
  callbacks: AgentStreamCallbacks,
  threadId: string,
  setMessages: (messages: UnifiedMessage[]) => void,
  agentId?: string, // Optional agent ID for invalidation
): UseAgentStreamResult {
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<string>('idle');
  const [textContent, setTextContent] = useState<
    { content: string; sequence?: number }[]
  >([]);
  
  // Add throttled state updates for smoother streaming
  const throttleRef = useRef<NodeJS.Timeout | null>(null);
  const pendingContentRef = useRef<{ content: string; sequence?: number }[]>([]);
  
  // Throttled content update function for smoother streaming
  const flushPendingContent = useCallback(() => {
    if (pendingContentRef.current.length > 0) {
      const newContent = [...pendingContentRef.current];
      pendingContentRef.current = [];
      
      React.startTransition(() => {
        setTextContent((prev) => [...prev, ...newContent]);
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
  const [toolCall, setToolCall] = useState<ParsedContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);

  const streamCleanupRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const currentRunIdRef = useRef<string | null>(null); // Ref to track the run ID being processed
  const threadIdRef = useRef(threadId); // Ref to hold the current threadId
  const setMessagesRef = useRef(setMessages); // Ref to hold the setMessages function

  const orderedTextContent = useMemo(() => {
    // Use a more efficient approach for streaming performance
    if (textContent.length === 0) return '';
    
    // Sort once and concatenate efficiently
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

  // On thread change, ensure any existing stream is cleaned up to avoid stale subscriptions
  useEffect(() => {
    const previousThreadId = threadIdRef.current;
    if (
      previousThreadId &&
      previousThreadId !== threadId &&
      streamCleanupRef.current
    ) {
      // Close the existing stream for the previous thread
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
  ); // Include error dependency

  // Function to handle finalization of a stream (completion, stop, error)
  const finalizeStream = useCallback(
    (finalStatus: string, runId: string | null = agentRunId) => {
      if (!isMountedRef.current) return;

      console.log(
        `[useAgentStream] Finalizing stream with status: ${finalStatus}, runId: ${runId}`,
      );

      const currentThreadId = threadIdRef.current; // Get current threadId from ref
      const currentSetMessages = setMessagesRef.current; // Get current setMessages from ref

      // Only finalize if this is for the current run ID or if no specific run ID is provided
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

      if (agentId) {
        queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
        queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
        queryClient.invalidateQueries({ queryKey: ['agent-tools', agentId] });

        queryClient.invalidateQueries({
          queryKey: ['custom-mcp-tools', agentId],
        });
        queryClient.invalidateQueries({ queryKey: composioKeys.mcpServers() });

        queryClient.invalidateQueries({
          queryKey: composioKeys.profiles.all(),
        });
        queryClient.invalidateQueries({
          queryKey: composioKeys.profiles.credentials(),
        });

        queryClient.invalidateQueries({ queryKey: ['triggers', agentId] });

        queryClient.invalidateQueries({
          queryKey: workflowKeys.agent(agentId),
        });

        queryClient.invalidateQueries({
          queryKey: knowledgeBaseKeys.agent(agentId),
        });

        // Invalidate versioning queries for agent config page
        queryClient.invalidateQueries({ queryKey: ['versions', 'list', agentId] });
        // Invalidate current version details if available
        queryClient.invalidateQueries({ 
          queryKey: ['versions', 'detail'], 
          predicate: (query) => {
            return query.queryKey.includes(agentId);
          }
        });
        
        console.log(`[useAgentStream] Invalidated agent queries for refetch instead of page reload - Agent ID: ${agentId}`);
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

  // --- Stream Callback Handlers ---

  const handleStreamMessage = useCallback(
    (rawData: string) => {
      if (!isMountedRef.current) return;
      (window as any).lastStreamMessage = Date.now(); // Keep track of last message time

      let processedData = rawData;
      if (processedData.startsWith('data: ')) {
        processedData = processedData.substring(6).trim();
      }
      if (!processedData) return;

      // --- Early exit for non-JSON completion messages ---
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

      // --- Check for error messages first ---
      try {
        const jsonData = JSON.parse(processedData);
        if (jsonData.status === 'error') {
          console.error(
            '[useAgentStream] Received error status message:',
            jsonData,
          );
          const errorMessage = jsonData.message || 'Unknown error occurred';
          setError(errorMessage);
          toast.error(errorMessage, { duration: 15000 });
          callbacks.onError?.(errorMessage);
          return;
        }
      } catch (jsonError) {
        // Not JSON or could not parse as JSON, continue processing
      }

      // --- Process JSON messages ---
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
      if (status !== 'streaming') updateStatus('streaming');

      switch (message.type) {
        case 'assistant':
          if (
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
            
            setTextContent([]);
            setToolCall(null);
            if (message.message_id) callbacks.onMessage(message);
          } else if (!parsedMetadata.stream_status) {
            // Handle non-chunked assistant messages if needed
            callbacks.onAssistantStart?.();
            if (message.message_id) callbacks.onMessage(message);
          }
          break;
        case 'tool':
          setToolCall(null); // Clear any streaming tool call
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
            case 'thread_run_end':
              break;
            case 'finish':
              // Optional: Handle finish reasons like 'xml_tool_limit_reached'
              // Don't finalize here, wait for thread_run_end or completion message
              break;
            case 'error':
              setError(parsedContent.message || 'Agent run failed');
              finalizeStream('error', currentRunIdRef.current);
              break;
            // Ignore thread_run_start, assistant_response_start etc. for now
            default:
              // console.debug('[useAgentStream] Received unhandled status type:', parsedContent.status_type);
              break;
          }
          break;
        case 'user':
        case 'system':
          // Handle other message types if necessary, e.g., if backend sends historical context
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
      threadId,
      setMessages,
      status,
      toolCall,
      callbacks,
      finalizeStream,
      updateStatus,
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
        // Standard EventSource errors don't have much detail, might need status check
        errorMessage = 'Stream connection error';
      }

      const lower = errorMessage.toLowerCase();
      const isExpected =
        lower.includes('not found') || lower.includes('not running');

      if (isExpected) {
        console.info('[useAgentStream] Streaming skipped/ended:', errorMessage);
      } else {
        console.error('[useAgentStream] Streaming error:', errorMessage, err);
        setError(errorMessage);
        // Show error toast with longer duration
        toast.error(errorMessage, { duration: 15000 });
      }

      const runId = currentRunIdRef.current;
      if (!runId) {
        console.warn(
          '[useAgentStream] Stream error occurred but no agentRunId is active.',
        );
        finalizeStream('error'); // Finalize with generic error if no runId
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
      // If status was streaming, something went wrong, finalize as error
      if (status === 'streaming' || status === 'connecting') {
        finalizeStream('error');
      } else if (
        status !== 'idle' &&
        status !== 'completed' &&
        status !== 'stopped' &&
        status !== 'agent_not_running'
      ) {
        // If in some other state, just go back to idle if no runId
        finalizeStream('idle');
      }
      return;
    }

    // Immediately check the agent status when the stream closes unexpectedly
    // This covers cases where the agent finished but the final message wasn't received,
    // or if the agent errored out on the backend.
    console.log(`[useAgentStream] Checking final status for run ID: ${runId}`);
    getAgentStatus(runId)
      .then((agentStatus) => {
        if (!isMountedRef.current) return; // Check mount status again

        // Check if this is still the current run ID
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
          finalizeStream('error', runId); // Finalize as error for now
          toast.warning('Stream disconnected. Agent might still be running.');
        } else {
          // Map backend terminal status to hook terminal status
          const finalStatus = mapAgentStatus(agentStatus.status);
          finalizeStream(finalStatus, runId);
        }
      })
      .catch((err) => {
        if (!isMountedRef.current) return;

        // Check if this is still the current run ID
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
          // Revert to agent_not_running for this specific case
          finalizeStream('agent_not_running', runId);
        } else {
          // For other errors checking status, finalize with generic error
          finalizeStream('error', runId);
        }
      });
  }, [status, finalizeStream]); // Include status

  // --- Effect to manage the stream lifecycle ---
  useEffect(() => {
    isMountedRef.current = true;

    // Cleanup function - be more conservative about stream cleanup
    return () => {
      isMountedRef.current = false;

      // Clean up throttle timeout
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
      
      // Flush any remaining pending content
      flushPendingContent();

      // Don't automatically cleanup streams on navigation
      // Only set mounted flag to false to prevent new operations
      // Streams will be cleaned up when they naturally complete or on explicit stop
    };
  }, []); // Empty dependency array for mount/unmount effect

  // --- Public Functions ---

  const startStreaming = useCallback(
    async (runId: string) => {
      if (!isMountedRef.current) return;

      console.log(`[useAgentStream] Starting stream for run ID: ${runId}`);

      // Store previous stream cleanup for potential restoration
      const previousCleanup = streamCleanupRef.current;
      const previousRunId = currentRunIdRef.current;

      try {
        // *** Crucial check: Verify agent is running BEFORE cleaning up previous stream ***
        console.log(`[useAgentStream] Checking status for run ID: ${runId}`);
        const agentStatus = await getAgentStatus(runId);
        if (!isMountedRef.current) return; // Check mount status after async call

        if (agentStatus.status !== 'running') {
          // Expected when opening an old conversation; don't surface as error/toast
          console.info(
            `[useAgentStream] Stream not started for ${runId}: Agent run ${runId} is not running (status: ${agentStatus.status})`,
          );
          
          // DON'T clean up the previous stream if this new one can't start
          // Just finalize with the appropriate status but keep previous stream if it was working
          const final =
            agentStatus.status === 'completed' ||
            agentStatus.status === 'stopped'
              ? mapAgentStatus(agentStatus.status)
              : 'agent_not_running';
          
          // Only finalize if we don't have a working previous stream
          if (!previousRunId || previousRunId === runId) {
            finalizeStream(final, runId);
          } else {
            console.log(`[useAgentStream] Keeping previous stream ${previousRunId} active since new stream ${runId} can't start`);
          }
          return;
        }

        // New agent is running, now it's safe to clean up previous stream
        if (previousCleanup && previousRunId !== runId) {
          console.log(`[useAgentStream] Cleaning up previous stream ${previousRunId} to start new stream ${runId}`);
          previousCleanup();
          streamCleanupRef.current = null;
        }

        // Reset state for the new stream
        setTextContent([]);
        setToolCall(null);
        setError(null);
        updateStatus('connecting');
        setAgentRunId(runId);
        currentRunIdRef.current = runId; // Set the ref immediately

        console.log(
          `[useAgentStream] Agent run ${runId} is running, creating stream`,
        );

        // Agent is running, proceed to create the stream
        const cleanup = streamAgent(runId, {
          onMessage: (data) => {
            // Ignore messages if threadId changed while the EventSource stayed open
            if (threadIdRef.current !== threadId) return;
            // Ignore messages if this is not the current run ID
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
        console.log(
          `[useAgentStream] Stream created successfully for run ID: ${runId}`,
        );

        // Status will be updated to 'streaming' by the first message received in handleStreamMessage
        // If for some reason no message arrives shortly, verify liveness again to avoid zombie state
        setTimeout(async () => {
          if (!isMountedRef.current) return;
          if (currentRunIdRef.current !== runId) return; // Another run started
          if (statusRef.current === 'streaming') return; // Already streaming
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
        if (!isMountedRef.current) return; // Check mount status after async call

        // Only handle error if this is still the current run ID
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
          
          // Similar logic - don't finalize if we have a working previous stream
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
          
          // For unexpected errors, still preserve previous stream if possible
          if (!previousRunId || previousRunId === runId) {
            finalizeStream('error', runId);
          } else {
            console.log(`[useAgentStream] Keeping previous stream ${previousRunId} active despite error starting new stream ${runId}`);
            // Reset current run ID back to previous to maintain stream continuity
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
  ); // Add dependencies

  const stopStreaming = useCallback(async () => {
    if (!isMountedRef.current || !agentRunId) return;

    const runIdToStop = agentRunId;

    // Immediately update status and clean up stream
    finalizeStream('stopped', runIdToStop);

    try {
      await stopAgent(runIdToStop);
      toast.success('Agent stopped.');
      // finalizeStream already called getAgentStatus implicitly if needed
    } catch (err) {
      // Don't revert status here, as the user intended to stop. Just log error.
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[useAgentStream] Error sending stop request for ${runIdToStop}: ${errorMessage}`,
      );
      toast.error(`Failed to stop agent: ${errorMessage}`);
    }
  }, [agentRunId, finalizeStream]); // Add dependencies

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
