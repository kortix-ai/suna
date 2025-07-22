import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
    avatar?: string;
    avatar_color?: string;
  };
  user_feedback?: boolean | null;
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
      user_feedback: msg.user_feedback ?? null,
      agent_id: (msg as any).agent_id,
      agents: (msg as any).agents,
    }));
};

export function useAgentStream(
  callbacks: AgentStreamCallbacks,
  threadId: string,
  setMessages: (messages: UnifiedMessage[]) => void,
): UseAgentStreamResult {
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('idle');
  const [textContent, setTextContent] = useState<
    { content: string; sequence?: number }[]
  >([]);
  const [toolCall, setToolCall] = useState<ParsedContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const streamCleanupRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const currentRunIdRef = useRef<string | null>(null); // Ref to track the run ID being processed
  const threadIdRef = useRef(threadId); // Ref to hold the current threadId
  const setMessagesRef = useRef(setMessages); // Ref to hold the setMessages function

  const orderedTextContent = useMemo(() => {
    return textContent
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .reduce((acc, curr) => acc + curr.content, '');
  }, [textContent]);

  // Update refs if threadId or setMessages changes
  useEffect(() => {
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

      const currentThreadId = threadIdRef.current; // Get current threadId from ref
      const currentSetMessages = setMessagesRef.current; // Get current setMessages from ref

      console.log(
        `[useAgentStream] Finalizing stream for ${runId} on thread ${currentThreadId} with status: ${finalStatus}`,
      );

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

      // --- Reliable Message Refetch on Finalization ---
      // Only refetch if the stream ended with a terminal status indicating the run is likely over
      const terminalStatuses = [
        'completed',
        'stopped',
        'failed',
        'error',
        'agent_not_running',
      ];
      if (currentThreadId && terminalStatuses.includes(finalStatus)) {
        console.log(
          `[useAgentStream] Refetching messages for thread ${currentThreadId} after finalization with status ${finalStatus}.`,
        );
        getMessages(currentThreadId)
          .then((messagesData: ApiMessageType[]) => {
            if (isMountedRef.current && messagesData) {
              console.log(
                `[useAgentStream] Refetched ${messagesData.length} messages for thread ${currentThreadId}.`,
              );
              const unifiedMessages = mapApiMessagesToUnified(
                messagesData,
                currentThreadId,
              );
              currentSetMessages(unifiedMessages); // Use the ref'd setMessages
            } else if (!isMountedRef.current) {
              console.log(
                `[useAgentStream] Component unmounted before messages could be set after refetch for thread ${currentThreadId}.`,
              );
            }
          })
          .catch((err) => {
            console.error(
              `[useAgentStream] Error refetching messages for thread ${currentThreadId} after finalization:`,
              err,
            );
            // Optionally notify the user via toast or callback
            toast.error(`Failed to refresh messages: ${err.message}`);
          });
      } else {
        console.log(
          `[useAgentStream] Skipping message refetch for thread ${currentThreadId}. Final status: ${finalStatus}`,
        );
      }

      // If the run was stopped or completed, try to get final status to update nonRunning set (keep this)
      if (
        runId &&
        (finalStatus === 'completed' ||
          finalStatus === 'stopped' ||
          finalStatus === 'agent_not_running')
      ) {
        getAgentStatus(runId).catch((err) => {
          console.log(
            `[useAgentStream] Post-finalization status check for ${runId} failed (this might be expected if not found): ${err.message}`,
          );
        });
      }
    },
    [agentRunId, updateStatus],
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
        console.log(
          '[useAgentStream] Received final completion status message',
        );
        finalizeStream('completed', currentRunIdRef.current);
        return;
      }
      if (
        processedData.includes('Run data not available for streaming') ||
        processedData.includes('Stream ended with status: completed')
      ) {
        console.log(
          `[useAgentStream] Detected final completion message: "${processedData}", finalizing.`,
        );
        finalizeStream('completed', currentRunIdRef.current);
        return;
      }

      // --- Check for error messages first ---
      try {
        const jsonData = JSON.parse(processedData);
        if (jsonData.status === 'error') {
          console.error('[useAgentStream] Received error status message:', jsonData);
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
      const message = safeJsonParse(processedData, null) as UnifiedMessage | null;
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
          console.log('[useAgentStream] test a:', parsedContent.content);
          console.log('[useAgentStream] test a1:', parsedMetadata);
          if (
            parsedMetadata.stream_status === 'chunk' &&
            parsedContent.content
          ) {
            setTextContent((prev) => {
              return prev.concat({
                sequence: message.sequence,
                content: parsedContent.content,
              });
            });
            callbacks.onAssistantChunk?.({ content: parsedContent.content });
          } else if (parsedMetadata.stream_status === 'complete') {
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
              console.log(
                '[useAgentStream] Received thread run end status, finalizing.',
              );
              break;
            case 'finish':
              // Optional: Handle finish reasons like 'xml_tool_limit_reached'
              console.log(
                '[useAgentStream] Received finish status:',
                parsedContent.finish_reason,
              );
              // Don't finalize here, wait for thread_run_end or completion message
              break;
            case 'error':
              console.error(
                '[useAgentStream] Received error status message:',
                parsedContent.message,
              );
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

      console.error('[useAgentStream] Streaming error:', errorMessage, err);
      setError(errorMessage);
      
      // Show error toast with longer duration
      toast.error(errorMessage, { duration: 15000 });

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
    console.log('[useAgentStream] Stream connection closed by server.');

    const runId = currentRunIdRef.current;
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
    getAgentStatus(runId)
      .then((agentStatus) => {
        if (!isMountedRef.current) return; // Check mount status again

        console.log(
          `[useAgentStream] Agent status after stream close for ${runId}: ${agentStatus.status}`,
        );
        if (agentStatus.status === 'running') {
          console.warn(
            `[useAgentStream] Stream closed for ${runId}, but agent is still running. Finalizing with error.`,
          );
          setError('Stream closed unexpectedly while agent was running.');
          finalizeStream('error', runId); // Finalize as error for now
          toast.warning('Stream disconnected. Agent might still be running.');
        } else {
          // Map backend terminal status to hook terminal status
          const finalStatus = mapAgentStatus(agentStatus.status);
          console.log(
            `[useAgentStream] Stream closed for ${runId}, agent status is ${agentStatus.status}. Finalizing stream as ${finalStatus}.`,
          );
          finalizeStream(finalStatus, runId);
        }
      })
      .catch((err) => {
        if (!isMountedRef.current) return;

        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(
          `[useAgentStream] Error checking agent status for ${runId} after stream close: ${errorMessage}`,
        );

        const isNotFoundError =
          errorMessage.includes('not found') ||
          errorMessage.includes('404') ||
          errorMessage.includes('does not exist');

        if (isNotFoundError) {
          console.log(
            `[useAgentStream] Agent run ${runId} not found after stream close. Finalizing.`,
          );
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

    // Cleanup function for when the component unmounts or agentRunId changes
    return () => {
      isMountedRef.current = false;
      console.log(
        '[useAgentStream] Unmounting or agentRunId changing. Cleaning up stream.',
      );
      if (streamCleanupRef.current) {
        streamCleanupRef.current();
        streamCleanupRef.current = null;
      }
      // Reset state on unmount if needed, though finalizeStream should handle most cases
      setStatus('idle');
      setTextContent([]);
      setToolCall(null);
      setError(null);
      setAgentRunId(null);
      currentRunIdRef.current = null;
    };
  }, []); // Empty dependency array for mount/unmount effect

  // --- Public Functions ---

  const startStreaming = useCallback(
    async (runId: string) => {
      if (!isMountedRef.current) return;
      console.log(
        `[useAgentStream] Received request to start streaming for ${runId}`,
      );

      // Clean up any previous stream
      if (streamCleanupRef.current) {
        console.log(
          '[useAgentStream] Cleaning up existing stream before starting new one.',
        );
        streamCleanupRef.current();
        streamCleanupRef.current = null;
      }

      // Reset state before starting
      setTextContent([]);
      setToolCall(null);
      setError(null);
      updateStatus('connecting');
      setAgentRunId(runId);
      currentRunIdRef.current = runId; // Set the ref immediately

      try {
        // *** Crucial check: Verify agent is running BEFORE connecting ***
        const agentStatus = await getAgentStatus(runId);
        if (!isMountedRef.current) return; // Check mount status after async call

        if (agentStatus.status !== 'running') {
          console.warn(
            `[useAgentStream] Agent run ${runId} is not in running state (status: ${agentStatus.status}). Cannot start stream.`,
          );
          setError(`Agent run is not running (status: ${agentStatus.status})`);
          finalizeStream(
            mapAgentStatus(agentStatus.status) || 'agent_not_running',
            runId,
          );
          return;
        }

        // Agent is running, proceed to create the stream
        console.log(
          `[useAgentStream] Agent run ${runId} confirmed running. Setting up EventSource.`,
        );
        const cleanup = streamAgent(runId, {
          onMessage: handleStreamMessage,
          onError: handleStreamError,
          onClose: handleStreamClose,
        });
        streamCleanupRef.current = cleanup;
        // Status will be updated to 'streaming' by the first message received in handleStreamMessage
      } catch (err) {
        if (!isMountedRef.current) return; // Check mount status after async call

        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(
          `[useAgentStream] Error initiating stream for ${runId}: ${errorMessage}`,
        );
        setError(errorMessage);

        const isNotFoundError =
          errorMessage.includes('not found') ||
          errorMessage.includes('404') ||
          errorMessage.includes('does not exist');

        finalizeStream(isNotFoundError ? 'agent_not_running' : 'error', runId);
      }
    },
    [
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
    console.log(
      `[useAgentStream] Stopping stream for agent run ${runIdToStop}`,
    );

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