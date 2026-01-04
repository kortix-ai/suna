import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { toast } from 'sonner';
import { ToolCallInput } from '@/components/thread/kortix-computer';
import { UnifiedMessage, ParsedMetadata, AgentStatus } from '@/components/thread/types';
import { safeJsonParse } from '@/components/thread/utils';
import { useIsMobile } from '@/hooks/utils';
import { isAskOrCompleteTool } from './utils';
import { useKortixComputerStore, useIsSidePanelOpen, useSetIsSidePanelOpen } from '@/stores/kortix-computer-store';
import { getOrAssignToolNumber, getToolNumber } from './tool-tracking';

interface UseThreadToolCallsReturn {
  toolCalls: ToolCallInput[];
  setToolCalls: React.Dispatch<React.SetStateAction<ToolCallInput[]>>;
  currentToolIndex: number;
  setCurrentToolIndex: React.Dispatch<React.SetStateAction<number>>;
  isSidePanelOpen: boolean;
  setIsSidePanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  autoOpenedPanel: boolean;
  setAutoOpenedPanel: React.Dispatch<React.SetStateAction<boolean>>;
  externalNavIndex: number | undefined;
  setExternalNavIndex: React.Dispatch<React.SetStateAction<number | undefined>>;
  handleToolClick: (clickedAssistantMessageId: string | null, clickedToolName: string, toolCallId?: string) => void;
  handleStreamingToolCall: (toolCall: UnifiedMessage | null) => void;
  toggleSidePanel: () => void;
  handleSidePanelNavigate: (newIndex: number) => void;
  userClosedPanelRef: React.MutableRefObject<boolean>;
}

// Helper function to check if a tool should be filtered out from the side panel
// Uses the shared utility from streaming-utils
function shouldFilterTool(toolName: string): boolean {
  // Always filter out ask and complete tools - they're rendered inline in ThreadContent
  return isAskOrCompleteTool(toolName);
}

export function useThreadToolCalls(
  messages: UnifiedMessage[],
  setLeftSidebarOpen?: (open: boolean) => void,
  agentStatus?: AgentStatus,
  compact?: boolean
): UseThreadToolCallsReturn {
  const [toolCalls, setToolCalls] = useState<ToolCallInput[]>([]);
  const [currentToolIndex, setCurrentToolIndex] = useState<number>(0);
  const isSidePanelOpen = useIsSidePanelOpen();
  const setIsSidePanelOpen = useSetIsSidePanelOpen();
  const [autoOpenedPanel, setAutoOpenedPanel] = useState(false);
  const [externalNavIndex, setExternalNavIndex] = useState<number | undefined>(undefined);
  const userClosedPanelRef = useRef(false);
  const userNavigatedRef = useRef(false);
  const isMobile = useIsMobile();
  
  const navigateToToolCall = useKortixComputerStore((state) => state.navigateToToolCall);

  const toggleSidePanel = useCallback(() => {
    const newState = !isSidePanelOpen;
    if (!newState) {
      userClosedPanelRef.current = true;
    }
    if (newState && setLeftSidebarOpen) {
      setLeftSidebarOpen(false);
    }
    setIsSidePanelOpen(newState);
  }, [isSidePanelOpen, setIsSidePanelOpen, setLeftSidebarOpen]);

  const handleSidePanelNavigate = useCallback((newIndex: number) => {
    setCurrentToolIndex(newIndex);
    userNavigatedRef.current = true;
  }, []);

  // Create a map of assistant message ID + tool name to their tool call indices for faster lookup
  // Key format: `${assistantMessageId}:${toolName}` -> toolIndex
  const assistantMessageToToolIndex = useRef<Map<string, number>>(new Map());
  
  // Track previous tool calls count to detect actual changes
  const prevToolCallsCountRef = useRef(0);

  // Memoize the computation of historical tool calls from messages
  // This avoids recomputing on unrelated state changes
  const { historicalToolPairs, messageIdAndToolNameToIndex } = useMemo(() => {
    const pairs: ToolCallInput[] = [];
    const indexMap = new Map<string, number>();
    const assistantMessages = messages.filter(m => m.type === 'assistant' && m.message_id);

    assistantMessages.forEach(assistantMsg => {
      // Get all tool results for this assistant message
      const resultMessages = messages.filter(toolMsg => {
        if (toolMsg.type !== 'tool' || !toolMsg.metadata || !assistantMsg.message_id) return false;
        try {
          const metadata = safeJsonParse<ParsedMetadata>(toolMsg.metadata, {});
          return metadata.assistant_message_id === assistantMsg.message_id;
        } catch (e) {
          return false;
        }
      });

      // Get tool calls from assistant message metadata
      const assistantMetadata = safeJsonParse<ParsedMetadata>(assistantMsg.metadata, {});
      const msgToolCalls = assistantMetadata.tool_calls || [];

      // Match each tool result to its corresponding tool call using tool_call_id
      resultMessages.forEach(resultMessage => {
        const toolMetadata = safeJsonParse<ParsedMetadata>(resultMessage.metadata, {});
        const toolResult = toolMetadata.result;
        const functionName = toolMetadata.function_name;
        const toolCallId = toolMetadata.tool_call_id;
        
        // Must have all required fields from metadata
        if (!toolResult || !functionName || !toolCallId) {
          return;
        }
        
        // Find matching tool call by tool_call_id
        const matchingToolCall = msgToolCalls.find(tc => tc.tool_call_id === toolCallId);
        
        if (!matchingToolCall) {
          return;
        }

        const toolName = functionName.replace(/_/g, '-').toLowerCase();
        const isSuccess = toolResult?.success !== false;
        
        // Get or assign tool identifier for verbose logging
        const existingNumber = getToolNumber(toolCallId);
        const toolNumber = getOrAssignToolNumber(toolCallId);

        // Check if this tool should be filtered out
        if (shouldFilterTool(toolName)) {
          return;
        }

        const toolIndex = pairs.length;
        // Normalize arguments - handle both string and object types
        let normalizedArguments: Record<string, any> = {};
        if (matchingToolCall.arguments) {
          if (typeof matchingToolCall.arguments === 'object' && matchingToolCall.arguments !== null) {
            normalizedArguments = matchingToolCall.arguments;
          } else if (typeof matchingToolCall.arguments === 'string') {
            try {
              normalizedArguments = JSON.parse(matchingToolCall.arguments);
            } catch {
              normalizedArguments = {};
            }
          }
        }
        pairs.push({
          toolCall: {
            tool_call_id: matchingToolCall.tool_call_id,
            function_name: matchingToolCall.function_name,
            arguments: normalizedArguments,
            source: matchingToolCall.source || 'xml',
          },
          toolResult: {
            success: toolResult?.success !== false,
            output: toolResult?.output,
            error: toolResult?.error || null,
          },
          assistantTimestamp: assistantMsg.created_at,
          toolTimestamp: resultMessage.created_at,
          isSuccess: isSuccess,
        });

        // Map the assistant message ID + tool name to its tool index
        if (assistantMsg.message_id) {
          const key = `${assistantMsg.message_id}:${toolName}`;
          indexMap.set(key, toolIndex);
        }
      });
    });

    return { historicalToolPairs: pairs, messageIdAndToolNameToIndex: indexMap };
  }, [messages]);

  // Update state only when computed tool calls actually change
  useEffect(() => {
    assistantMessageToToolIndex.current = messageIdAndToolNameToIndex;
    
    // Only update toolCalls state if the count changed (simple heuristic to avoid deep comparison)
    if (historicalToolPairs.length !== prevToolCallsCountRef.current) {
      prevToolCallsCountRef.current = historicalToolPairs.length;
      setToolCalls(historicalToolPairs);
    }
  }, [historicalToolPairs, messageIdAndToolNameToIndex, messages.length]);

  // Separate effect for UI state management (side panel, current index)
  // This prevents recomputation of tool calls when UI state changes
  useEffect(() => {
    if (historicalToolPairs.length > 0) {
      if (agentStatus === 'running' && !userNavigatedRef.current) {
        setCurrentToolIndex(historicalToolPairs.length - 1);
      } else if (isSidePanelOpen && !userClosedPanelRef.current && !userNavigatedRef.current) {
        setCurrentToolIndex(historicalToolPairs.length - 1);
      } else if (!isSidePanelOpen && !autoOpenedPanel && !userClosedPanelRef.current && !isMobile && !compact) {
        setCurrentToolIndex(historicalToolPairs.length - 1);
        setIsSidePanelOpen(true);
        setAutoOpenedPanel(true);
      }
    }
  }, [historicalToolPairs.length, isSidePanelOpen, autoOpenedPanel, agentStatus, isMobile, compact, setIsSidePanelOpen]);

  // Reset user navigation flag when agent stops
  useEffect(() => {
    if (agentStatus === 'idle') {
      userNavigatedRef.current = false;
    }
  }, [agentStatus]);

  useEffect(() => {
    if (!isSidePanelOpen) {
      setAutoOpenedPanel(false);
    }
  }, [isSidePanelOpen]);

  const handleToolClick = useCallback((clickedAssistantMessageId: string | null, clickedToolName: string, toolCallId?: string) => {
    userClosedPanelRef.current = false;
    userNavigatedRef.current = true;

    // Helper function to navigate to a tool index
    const navigateToIndex = (index: number) => {
      setExternalNavIndex(index);
      setCurrentToolIndex(index);
      setIsSidePanelOpen(true);
      // Use store action to ensure KortixComputer switches to tools view
      navigateToToolCall(index);
      setTimeout(() => setExternalNavIndex(undefined), 100);
    };

    // If we have a tool_call_id, use it for precise matching (works for both streaming and completed)
    if (toolCallId) {
      const foundIndex = toolCalls.findIndex(tc => tc.toolCall.tool_call_id === toolCallId);
      if (foundIndex !== -1) {
        navigateToIndex(foundIndex);
        return;
      }
      console.warn(`[handleToolClick] Could not find tool call with ID: ${toolCallId}`);
    }

    // Handle streaming tool calls (message ID is null)
    if (!clickedAssistantMessageId) {
      // Find the latest streaming tool call (one without a toolResult yet)
      // Search from the end backwards to find the most recent streaming tool
      for (let i = toolCalls.length - 1; i >= 0; i--) {
        const toolCall = toolCalls[i];
        // A streaming tool call doesn't have a toolResult yet
        if (!toolCall.toolResult) {
          const toolName = toolCall.toolCall.function_name.replace(/_/g, '-').toLowerCase();
          const normalizedToolName = clickedToolName.replace(/_/g, '-').toLowerCase();
          
          // If tool name matches or clickedToolName is 'unknown', navigate to this streaming tool
          if (toolName === normalizedToolName || clickedToolName === 'unknown') {
            navigateToIndex(i);
            return;
          }
        }
      }
      
      // If no matching streaming tool found, just open the latest tool call (streaming or not)
      if (toolCalls.length > 0) {
        navigateToIndex(toolCalls.length - 1);
        return;
      }
      
      console.warn("No streaming tool calls found to open.");
      return;
    }

    // Normalize tool name to match the format used in the mapping (lowercase, with dashes)
    const normalizedToolName = clickedToolName.replace(/_/g, '-').toLowerCase();
    
    // Use the pre-computed mapping with composite key: assistantMessageId:toolName
    const compositeKey = `${clickedAssistantMessageId}:${normalizedToolName}`;
    const toolIndex = assistantMessageToToolIndex.current.get(compositeKey);

    // #region debug - tool click debugging
    console.log('[handleToolClick] Debug', {
      clickedAssistantMessageId,
      clickedToolName,
      normalizedToolName,
      compositeKey,
      toolIndex,
      toolCallsLength: toolCalls.length,
      mapSize: assistantMessageToToolIndex.current.size,
      mapKeys: Array.from(assistantMessageToToolIndex.current.keys()).slice(0, 10),
    });
    // #endregion

    if (toolIndex !== undefined) {
      navigateToIndex(toolIndex);
    } else {
      console.warn(
        `[PAGE] Could not find matching tool call in toolCalls array for assistant message ID: ${clickedAssistantMessageId}, tool name: ${clickedToolName}`,
      );
      
      // Fallback: Try to find by searching through toolCalls array
      // Find the assistant message and match by tool name
      const assistantMessage = messages.find(
        m => m.message_id === clickedAssistantMessageId && m.type === 'assistant'
      );
      
      if (assistantMessage) {
        // Get tool calls from assistant message metadata
        const assistantMetadata = safeJsonParse<ParsedMetadata>(assistantMessage.metadata, {});
        const toolCallsFromMetadata = assistantMetadata.tool_calls || [];
        
        // Find the matching tool call by function name
        const matchingToolCall = toolCallsFromMetadata.find(tc => {
          const tcToolName = tc.function_name.replace(/_/g, '-').toLowerCase();
          return tcToolName === normalizedToolName;
        });
        
        if (matchingToolCall) {
          // Find the tool call in the toolCalls array by tool_call_id
          const foundIndex = toolCalls.findIndex(
            tc => tc.toolCall.tool_call_id === matchingToolCall.tool_call_id
          );
          
          if (foundIndex !== -1) {
            navigateToIndex(foundIndex);
            return;
          }
        }
      }
      
      toast.info('Could not find details for this tool call.');
    }
  }, [messages, toolCalls, navigateToToolCall, setIsSidePanelOpen]);

  const handleStreamingToolCall = useCallback(
    (toolCall: UnifiedMessage | null) => {
      if (!toolCall) return;

      // Extract tool calls from UnifiedMessage metadata.tool_calls
      const metadata = safeJsonParse<ParsedMetadata>(toolCall.metadata, {});
      const toolCallsFromMetadata = metadata.tool_calls || [];

      if (toolCallsFromMetadata.length === 0) return;

      // Filter out ask and complete tools
      const filteredToolCalls = toolCallsFromMetadata.filter(tc => {
        const toolName = tc.function_name.replace(/_/g, '-').toLowerCase();
        return toolName !== 'ask' && toolName !== 'complete';
      });

      if (filteredToolCalls.length === 0) return;

      if (userClosedPanelRef.current) return;

      // Track if we added any new tool calls using an object (to allow mutation in closure)
      const tracker = { addedNewToolCall: false, newToolCallCount: 0 };

      // Process each tool call from metadata
      setToolCalls((prev) => {
        const updated = [...prev];
        
        // Update or add each tool call from metadata
        filteredToolCalls.forEach((metadataToolCall) => {
        const toolCallId = metadataToolCall.tool_call_id;
        const functionName = metadataToolCall.function_name;
        
        // Get or assign tool identifier for verbose logging
        const existingNumber = getToolNumber(toolCallId);
        const toolNumber = getOrAssignToolNumber(toolCallId);
          
          const existingIndex = updated.findIndex(
            tc => tc.toolCall.tool_call_id === toolCallId
          );

          // Keep raw string for streaming partial JSON parsing, parse to object for completed
          const rawArgs = metadataToolCall.arguments;
          const parsedArgs = (() => {
            if (!rawArgs) return {};
            if (typeof rawArgs === 'object' && rawArgs !== null) return rawArgs;
            if (typeof rawArgs === 'string') {
              try {
                return JSON.parse(rawArgs);
              } catch {
                return {}; // Partial JSON - will use rawArgs for streaming
              }
            }
            return {};
          })();

          // Check if this tool call has a result (from useAgentStream merging)
          const toolResult = (metadataToolCall as any).tool_result;
          const isCompleted = (metadataToolCall as any).completed === true;
          
          const newToolCall: ToolCallInput = {
            toolCall: {
              tool_call_id: metadataToolCall.tool_call_id,
              function_name: metadataToolCall.function_name,
              arguments: parsedArgs,
              // Store raw string for streaming partial JSON parsing
              rawArguments: typeof rawArgs === 'string' ? rawArgs : undefined,
              source: metadataToolCall.source || 'native',
            },
            // Merge tool result if available (real-time result from useAgentStream)
            toolResult: toolResult ? {
              success: toolResult.success !== false,
              output: toolResult.output,
              error: toolResult.error || null,
            } : undefined,
            isSuccess: toolResult ? (toolResult.success !== false) : true,
            assistantTimestamp: toolCall.created_at || new Date().toISOString(),
            messages: messages as any,
          };

          if (existingIndex !== -1) {
            const args = metadataToolCall.arguments;
            let normalizedArgs: Record<string, any> = {};
            let rawArgsStr: string | undefined = undefined;
            if (args) {
              if (typeof args === 'object' && args !== null) {
                normalizedArgs = args;
              } else if (typeof args === 'string') {
                rawArgsStr = args; // Keep raw string for streaming
                try {
                  normalizedArgs = JSON.parse(args);
                } catch {
                  normalizedArgs = {};
                }
              }
            }
            
            // Merge tool result if available (real-time update)
            const mergedToolResult = toolResult ? {
              success: toolResult.success !== false,
              output: toolResult.output,
              error: toolResult.error || null,
            } : updated[existingIndex].toolResult;
            
            updated[existingIndex] = {
              ...updated[existingIndex],
              toolCall: {
                ...updated[existingIndex].toolCall,
                arguments: normalizedArgs,
                rawArguments: rawArgsStr,
              },
              // Update tool result if available (real-time merge)
              toolResult: mergedToolResult,
              isSuccess: mergedToolResult ? (mergedToolResult.success !== false) : updated[existingIndex].isSuccess,
              messages: messages as any,
            };
          } else {
            updated.push(newToolCall);
            tracker.addedNewToolCall = true;
          }
        });

        tracker.newToolCallCount = updated.length;
        return updated;
      });

      if (!compact) {
        setIsSidePanelOpen(true);
      }

      // Auto-navigate to the latest tool call when a new one is added (if user hasn't manually navigated)
      if (tracker.addedNewToolCall && !userNavigatedRef.current) {
        // Use setTimeout to ensure state has updated
        setTimeout(() => {
          setCurrentToolIndex(tracker.newToolCallCount - 1);
          navigateToToolCall(tracker.newToolCallCount - 1);
        }, 0);
      }
    },
    [compact, navigateToToolCall, messages, setIsSidePanelOpen],
  );
  
  // Update current tool index when toolCalls changes (if user hasn't manually navigated)
  useEffect(() => {
    if (!userNavigatedRef.current && toolCalls.length > 0) {
      setCurrentToolIndex(toolCalls.length - 1);
    }
  }, [toolCalls.length]);

  return {
    toolCalls,
    setToolCalls,
    currentToolIndex,
    setCurrentToolIndex,
    isSidePanelOpen,
    setIsSidePanelOpen,
    autoOpenedPanel,
    setAutoOpenedPanel,
    externalNavIndex,
    setExternalNavIndex,
    handleToolClick,
    handleStreamingToolCall,
    toggleSidePanel,
    handleSidePanelNavigate,
    userClosedPanelRef,
  };
}
