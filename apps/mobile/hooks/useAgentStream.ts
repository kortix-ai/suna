import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import EventSource from 'react-native-sse';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { UnifiedMessage, ParsedContent, ParsedMetadata } from '@/api/types';
import { API_URL, getAuthToken } from '@/api/config';
import { safeJsonParse } from '@/lib/utils/message-grouping';
import { chatKeys } from '@/lib/chat';

interface UseAgentStreamResult {
  status: string;
  textContent: string;
  toolCall: UnifiedMessage | null; // Changed from ParsedContent to UnifiedMessage
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
  onToolCallChunk?: (message: UnifiedMessage) => void; // New callback for tool call chunks
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
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingContentRef = useRef<{ content: string; sequence?: number }[]>([]);
  
  // Throttled content update function for smoother streaming
  const flushPendingContent = useCallback(() => {
    // Clear and release any pending throttle to avoid starving updates
    if (throttleRef.current) {
      clearTimeout(throttleRef.current);
      throttleRef.current = null;
    }

    if (pendingContentRef.current.length > 0) {
      // Sort chunks by sequence before adding to state
      const sortedContent = pendingContentRef.current.slice().sort((a, b) => {
        const aSeq = a.sequence ?? 0;
        const bSeq = b.sequence ?? 0;
        return aSeq - bSeq;
      });
      pendingContentRef.current = [];
      
      // Use React.startTransition for smoother updates (works in React Native)
      setTextContent((prev) => {
        // Combine with existing content and sort all together
        const combined = [...prev, ...sortedContent];
        return combined.sort((a, b) => {
          const aSeq = a.sequence ?? 0;
          const bSeq = b.sequence ?? 0;
          return aSeq - bSeq;
        });
      });
    }
  }, []);
  
  const addContentThrottled = useCallback((content: { content: string; sequence?: number }) => {
    pendingContentRef.current.push(content);
    
    // True throttle: only schedule a flush if one isn't already pending
    if (throttleRef.current) {
      return;
    }
    
    // Set throttle for smooth updates (16ms ≈ 60fps)
    throttleRef.current = setTimeout(() => {
      flushPendingContent();
    }, 16);
  }, [flushPendingContent]);
  
  const [toolCall, setToolCall] = useState<UnifiedMessage | null>(null); // Changed from ParsedContent
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
  
  // DELTA STREAMING: Track accumulated tool call arguments with sequence numbers
  // Structure: Map<toolCallId, { metadata: ToolCallMetadata, chunks: Array<{sequence: number, delta: string}> }>
  interface AccumulatedToolCall {
    metadata: {
      tool_call_id: string;
      function_name: string;
      index?: number;
      [key: string]: any;
    };
    chunks: Array<{sequence: number, delta: string}>;
  }
  const accumulatedToolCallsRef = useRef<Map<string, AccumulatedToolCall>>(new Map());
  
  // Track completed tool call IDs (tools that have received results)
  const completedToolCallIdsRef = useRef<Set<string>>(new Set());
  
  // Track tool results by tool_call_id for merging with streaming tool calls
  const toolResultsRef = useRef<Map<string, UnifiedMessage>>(new Map());

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
      // Clear accumulated tool call deltas and previous state
      accumulatedToolCallsRef.current.clear();
      completedToolCallIdsRef.current.clear();
      toolResultsRef.current.clear();
      
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

      console.log(
        `[useAgentStream] Finalizing stream with status: ${finalStatus}, runId: ${runId}`,
      );

      const currentThreadId = threadIdRef.current;
      const currentSetMessages = setMessagesRef.current;

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
        queryKey: ['active-agent-runs'],
      });

      // Refetch thread messages to ensure all messages are synced with the database
      queryClient.invalidateQueries({
        queryKey: chatKeys.messages(currentThreadId),
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
        '{"type": "status", "status": "completed", "message": "Worker run completed successfully"}'
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

      // Check for error messages and special message types first
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
        // Handle ping messages (keep-alive) - only ignore if truly empty
        if (jsonData.type === 'ping') {
          // Only ignore ping if it has no content field or content is empty
          if (!jsonData.content) {
            return;
          }
          // If ping has content, log it and continue processing (shouldn't happen, but safer)
          console.log('[useAgentStream] ⚠️ Ping message with content, continuing processing:', {
            hasContent: !!jsonData.content,
            contentLength: jsonData.content?.length,
          });
          // Continue to normal processing path below
        }
        // Handle tool_output_stream messages - only ignore if truly empty
        if (jsonData.type === 'tool_output_stream') {
          // Log what we're receiving for debugging
          console.log('[useAgentStream] 📦 Received tool_output_stream message:', {
            tool_call_id: jsonData.tool_call_id,
            tool_name: jsonData.tool_name,
            hasOutput: !!jsonData.output,
            outputLength: jsonData.output?.length,
            is_final: jsonData.is_final,
          });
          
          // Only ignore tool_output_stream if it has no output field or output is empty
          if (!jsonData.output) {
            console.log('[useAgentStream] Ignoring empty tool_output_stream');
            return;
          }
          
          // If tool_output_stream has output but shouldn't be processed as text, log it
          // Note: tool_output_stream is for tool output streaming, not regular text chunks
          // But we log it to help debug if text chunks are being mislabeled
          const outputStr = typeof jsonData.output === 'string' ? jsonData.output : String(jsonData.output);
          console.log('[useAgentStream] ⚠️ tool_output_stream with output (not processing as text):', {
            outputPreview: outputStr.substring(0, 100),
            outputLength: outputStr.length,
            outputType: typeof jsonData.output,
          });
          // Continue to normal processing path below - this allows the message to be processed
          // if it's actually a mislabeled text chunk, but typically tool_output_stream
          // should be handled separately (not implemented in mobile yet)
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
        updateStatus('streaming');
      }

      switch (message.type) {
        case 'assistant':
          if (parsedMetadata.stream_status === 'tool_call_chunk') {
            // Handle tool call chunks - extract from metadata.tool_calls
            const toolCalls = parsedMetadata.tool_calls || [];
            if (toolCalls.length > 0) {
              // DELTA STREAMING: Accumulate deltas into full tool calls with sequence ordering
              // First, update the accumulator with new deltas from this chunk
              for (const tc of toolCalls as any[]) {
                const toolCallId = tc.tool_call_id || 'unknown';
                const sequence = message.sequence ?? 0;
                
                // Get or create the accumulated entry for this tool call
                let accumulated = accumulatedToolCallsRef.current.get(toolCallId);
                const isNewToolCall = !accumulated;
                if (!accumulated) {
                  console.log(`[useAgentStream] 🆕 New tool call detected: ${toolCallId} (${tc.function_name})`);
                  accumulated = {
                    metadata: {
                      tool_call_id: tc.tool_call_id,
                      function_name: tc.function_name,
                      index: tc.index,
                    },
                    chunks: [],
                  };
                  accumulatedToolCallsRef.current.set(toolCallId, accumulated);
                }
                
                // Update metadata if we have newer info (function_name might come later)
                if (tc.function_name) {
                  accumulated.metadata.function_name = tc.function_name;
                }
                if (tc.index !== undefined) {
                  accumulated.metadata.index = tc.index;
                }
                
                if (tc.is_delta && tc.arguments_delta) {
                  // This is a delta update - store it with sequence number
                  const existingIndex = accumulated.chunks.findIndex(c => c.sequence === sequence);
                  if (existingIndex >= 0) {
                    accumulated.chunks[existingIndex].delta = tc.arguments_delta;
                  } else {
                    accumulated.chunks.push({ sequence, delta: tc.arguments_delta });
                  }
                  // Sort chunks by sequence number
                  accumulated.chunks.sort((a, b) => a.sequence - b.sequence);
                } else if (tc.arguments) {
                  // Full arguments (non-delta) - replace all chunks with single full argument
                  const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
                  accumulated.chunks = [{ sequence, delta: argsStr }];
                }
              }
              
              // Now reconstruct ALL accumulated tool calls (not just from this message)
              // Merge streaming tool calls with completed tool results
              const allReconstructedToolCalls = Array.from(accumulatedToolCallsRef.current.values())
                .sort((a, b) => (a.metadata.index ?? 0) - (b.metadata.index ?? 0))
                .map(accumulated => {
                  // Merge all chunks for this tool call
                  let mergedArgs = '';
                  for (const chunk of accumulated.chunks) {
                    mergedArgs += chunk.delta;
                  }
                  
                  const toolCallId = accumulated.metadata.tool_call_id;
                  const isCompleted = completedToolCallIdsRef.current.has(toolCallId);
                  const toolResult = toolResultsRef.current.get(toolCallId);
                  
                  // Don't log status on every chunk - too verbose
                  // Status is already logged when result is received
                  
                  return {
                    tool_call_id: toolCallId,
                    function_name: accumulated.metadata.function_name,
                    index: accumulated.metadata.index,
                    arguments: mergedArgs,
                    is_delta: false, // Mark as assembled
                    completed: isCompleted,
                    tool_result: toolResult ? safeJsonParse<ParsedMetadata>(toolResult.metadata, {}).result : undefined,
                  };
                });
              
              // Also include completed tools that may have results but aren't in accumulated ref
              // (edge case: result arrives before tool call is fully streamed)
              toolResultsRef.current.forEach((resultMessage, toolCallId) => {
                if (!accumulatedToolCallsRef.current.has(toolCallId)) {
                  const toolMetadata = safeJsonParse<ParsedMetadata>(resultMessage.metadata, {});
                  const functionName = toolMetadata.function_name;
                  if (functionName) {
                    // Add to reconstructed calls if not already present
                    const existing = allReconstructedToolCalls.find(tc => tc.tool_call_id === toolCallId);
                    if (!existing) {
                      allReconstructedToolCalls.push({
                        tool_call_id: toolCallId,
                        function_name: functionName,
                        index: toolMetadata.index,
                        arguments: '{}',
                        is_delta: false,
                        completed: true,
                        tool_result: toolMetadata.result,
                      });
                    }
                  }
                }
              });
              
              // Re-sort after adding any missing completed tools
              allReconstructedToolCalls.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
              
              // Create updated message with ALL reconstructed tool calls
              const updatedMessage = {
                ...message,
                metadata: JSON.stringify({
                  ...parsedMetadata,
                  tool_calls: allReconstructedToolCalls,
                }),
              };
              
              // Only log state updates when there's a meaningful change (new tool call or result added)
              // Too verbose to log on every chunk update - logs are already present when results arrive
              
              // Set toolCall state with ALL reconstructed tool calls
              setToolCall(updatedMessage);
              // Call the callback with the reconstructed message
              callbacks.onToolCallChunk?.(updatedMessage);
            }
          } else if (
            parsedMetadata.stream_status === 'chunk' &&
            parsedContent.content
          ) {
            if (retryCountRef.current > 0) {
              console.log('[useAgentStream] Successfully connected, resetting retry counter');
              retryCountRef.current = 0;
            }
            
            
            // Use throttled approach for smoother streaming
            addContentThrottled({
              sequence: message.sequence,
              content: parsedContent.content,
            });
            callbacks.onAssistantChunk?.({ content: parsedContent.content });
          } else if (parsedMetadata.stream_status === 'complete') {
            // Flush any pending content before completing
            flushPendingContent();
            
            console.log(`[useAgentStream] 🏁 Assistant message complete - clearing tool call state`, {
              accumulatedToolCalls: accumulatedToolCallsRef.current.size,
              completedToolCalls: completedToolCallIdsRef.current.size,
              toolResults: toolResultsRef.current.size,
              completedToolCallIds: Array.from(completedToolCallIdsRef.current),
            });
            
            setTextContent([]);
            setToolCall(null);
            // Clear accumulated tool call deltas and previous state when assistant message completes
            accumulatedToolCallsRef.current.clear();
            completedToolCallIdsRef.current.clear();
            toolResultsRef.current.clear();
            if (message.message_id) callbacks.onMessage(message);
          } else if (!parsedMetadata.stream_status) {
            // Handle non-chunked assistant messages if needed
            callbacks.onAssistantStart?.();
            if (message.message_id) callbacks.onMessage(message);
          }
          break;
        case 'tool':
          // Don't clear toolCall state here - other tools may still be streaming
          // Mark this tool as completed and store its result, but keep other tools in accumulated ref
          
          // Process tool result
          try {
            const toolMetadata = safeJsonParse<ParsedMetadata>(message.metadata, {});
            const toolCallId = toolMetadata.tool_call_id;
            const functionName = toolMetadata.function_name;
            if (toolCallId && functionName) {
              console.log(`[useAgentStream] 🎯 Received tool result for: ${toolCallId} (${functionName})`, {
                hasResult: !!toolMetadata.result,
                resultType: toolMetadata.result ? typeof toolMetadata.result : 'none',
                resultKeys: toolMetadata.result && typeof toolMetadata.result === 'object' 
                  ? Object.keys(toolMetadata.result) 
                  : null,
              });
              
              // Mark this tool call as completed
              completedToolCallIdsRef.current.add(toolCallId);
              console.log(`[useAgentStream] ✅ Marked tool call as completed: ${toolCallId}`);
              
              // Store the tool result for merging with streaming tool calls
              toolResultsRef.current.set(toolCallId, message);
              console.log(`[useAgentStream] 💾 Stored tool result in toolResultsRef: ${toolCallId}`);
              
              // Trigger an update to streamingToolCall to include this completed tool with its result
              // Reconstruct all tool calls including this completed one
              const allReconstructedToolCalls = Array.from(accumulatedToolCallsRef.current.values())
                .sort((a, b) => (a.metadata.index ?? 0) - (b.metadata.index ?? 0))
                .map(accumulated => {
                  let mergedArgs = '';
                  for (const chunk of accumulated.chunks) {
                    mergedArgs += chunk.delta;
                  }
                  
                  const tcId = accumulated.metadata.tool_call_id;
                  const isCompleted = completedToolCallIdsRef.current.has(tcId);
                  const toolResult = toolResultsRef.current.get(tcId);
                  
                  return {
                    tool_call_id: tcId,
                    function_name: accumulated.metadata.function_name,
                    index: accumulated.metadata.index,
                    arguments: mergedArgs,
                    is_delta: false,
                    completed: isCompleted,
                    tool_result: toolResult ? safeJsonParse<ParsedMetadata>(toolResult.metadata, {}).result : undefined,
                  };
                });
              
              // Include completed tools that may not be in accumulated ref
              toolResultsRef.current.forEach((resultMsg, tcId) => {
                if (!accumulatedToolCallsRef.current.has(tcId)) {
                  const resultMetadata = safeJsonParse<ParsedMetadata>(resultMsg.metadata, {});
                  const fnName = resultMetadata.function_name;
                  if (fnName) {
                    const existing = allReconstructedToolCalls.find(tc => tc.tool_call_id === tcId);
                    if (!existing) {
                      allReconstructedToolCalls.push({
                        tool_call_id: tcId,
                        function_name: fnName,
                        index: resultMetadata.index,
                        arguments: '{}',
                        is_delta: false,
                        completed: true,
                        tool_result: resultMetadata.result,
                      });
                    }
                  }
                }
              });
              
              allReconstructedToolCalls.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
              
              // Update streamingToolCall to include this completed tool with its result
              const updatedMessageWithResults = {
                ...message,
                metadata: JSON.stringify({
                  ...toolMetadata,
                  tool_calls: allReconstructedToolCalls,
                }),
              };
              
              console.log(`[useAgentStream] 🔄 Updating tool call state with result for ${toolCallId}`, {
                totalToolCalls: allReconstructedToolCalls.length,
                completedCount: allReconstructedToolCalls.filter((tc: any) => tc.completed).length,
                toolCallsWithResults: allReconstructedToolCalls.filter((tc: any) => tc.tool_result).length,
              });
              
              // Force update to streamingToolCall state
              setToolCall(updatedMessageWithResults);
              
              // Also call the callback to notify downstream handlers
              callbacks.onToolCallChunk?.(updatedMessageWithResults);
            }
          } catch (e) {
            // Ignore parsing errors
          }
          
          // DO NOT clear accumulatedToolCallsRef - other tools may still be streaming
          // Only clear when assistant message completes (handled in case 'assistant' with stream_status === 'complete')
          if (message.message_id) callbacks.onMessage(message);
          break;
        case 'status':
          switch (parsedContent.status_type) {
            case 'tool_completed':
            case 'tool_failed':
            case 'tool_error':
              console.log(`[useAgentStream] 📊 Status message: ${parsedContent.status_type}`, {
                message: parsedContent.message,
                accumulatedToolCalls: accumulatedToolCallsRef.current.size,
                completedToolCalls: completedToolCallIdsRef.current.size,
                toolResults: toolResultsRef.current.size,
              });
              // Don't clear toolCall state here - other tools may still be streaming
              // Individual tool completion is handled by useThreadToolCalls via the messages array
              // DO NOT clear accumulated tool calls - status messages don't indicate all tools are done
              // Only clear when assistant message completes
              break;
            case 'finish':
              // Optional: Handle finish reasons like 'xml_tool_limit_reached'
              // Don't finalize here, wait for thread_run_end or completion message
              break;
            // case 'thread_run_end':
            //   // Thread run has ended - finalize the stream
            //   console.log(`[useAgentStream] 🏁 Thread run ended - finalizing stream`);
            //   finalizeStream('completed', currentRunIdRef.current);
            //   break;
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
          // llm_response_end and llm_response_start messages are ignored (metadata only)
          break;
        case 'user':
        case 'system':
          // Handle other message types if necessary
          if (message.message_id) callbacks.onMessage(message);
          break;
        default:
          // Note: ping and tool_output_stream messages are handled in the error checking section above
          // and return early, so they shouldn't reach here. If they do, ignore them silently.
          const messageType = (message as any).type;
          if (messageType === 'ping' || messageType === 'tool_output_stream') {
            // These are handled in the error checking section above, ignore here
            break;
          }
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

        // Get auth credentials (token for authenticated users)
        const token = await getAuthToken();
        
        console.log('[useAgentStream] 🔐 Auth check:', {
          hasToken: !!token,
        });
        
        let url = `${API_URL}/agent-run/${runId}/stream`;
        if (token) {
          url += `?token=${token}`;
          console.log('[useAgentStream] ✅ Using token auth for stream');
        } else {
          console.error('[useAgentStream] ❌ NO AUTH CREDENTIALS AVAILABLE!');
        }
        
        console.log('[useAgentStream] 🌐 Stream URL:', url.replace(/token=[^&]+/, 'token=[HIDDEN]'));
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
