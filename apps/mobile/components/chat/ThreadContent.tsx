import React, { useMemo, useCallback } from 'react';
import { View, Pressable, Text as RNText, Platform, Image } from 'react-native';
import * as Clipboard from 'expo-clipboard';
// NOTE: useSmoothText removed - following frontend pattern of displaying content immediately
// The old interface was also broken (wrong parameters and return type)

// Only import ContextMenu on native platforms (iOS/Android)
let ContextMenu: React.ComponentType<any> | null = null;
if (Platform.OS !== 'web') {
  try {
    ContextMenu = require('react-native-context-menu-view').default;
  } catch (e) {
    log.warn('react-native-context-menu-view not available');
  }
}
import { Text } from '@/components/ui/text';
import type { UnifiedMessage, ParsedContent, ParsedMetadata } from '@agentpress/shared';
import {
  safeJsonParse,
  getUserFriendlyToolName,
  extractTextFromArguments,
  isAskOrCompleteTool,
  findAskOrCompleteTool,
  shouldSkipStreamingRender,
} from '@agentpress/shared';
import {
  parseToolMessage,
} from '@agentpress/shared/tools';
import { groupMessagesWithStreaming } from '@agentpress/shared/utils';
import { preprocessTextOnlyTools } from '@agentpress/shared/tools';
import { useColorScheme } from 'nativewind';
import { useAgent } from '@/contexts/AgentContext';
import { SelectableMarkdownText } from '@/components/ui/selectable-markdown';
import { autoLinkUrls } from '@agentpress/shared';
import { FileAttachmentsGrid } from './FileAttachmentRenderer';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { AgentLoader } from './AgentLoader';
import { StreamingToolCard } from './StreamingToolCard';
import { CompactToolCard, CompactStreamingToolCard } from './CompactToolCard';
import { MediaGenerationInline } from './MediaGenerationInline';
import { SlideInlineThumbnail, SlideInfo } from './SlideInlineThumbnail';
import { EnhancedToolCard } from './EnhancedToolCard';
import { MessageActions } from './MessageActions';
import { renderAssistantMessage } from './assistant-message-renderer';
import { ReasoningSection } from './ReasoningSection';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { isKortixDefaultAgentId } from '@/lib/agents';
import { log } from '@/lib/logger';

export interface ToolMessagePair {
  assistantMessage: UnifiedMessage | null;
  toolMessage: UnifiedMessage;
}

function renderStandaloneAttachments(
  attachments: string[],
  sandboxId?: string,
  sandboxUrl?: string,
  onFilePress?: (filePath: string) => void,
  alignRight: boolean = false
) {
  if (!attachments || attachments.length === 0) return null;

  const validAttachments = attachments.filter(
    (attachment) => attachment && attachment.trim() !== ''
  );
  if (validAttachments.length === 0) return null;

  return (
    <View className={`my-4 ${alignRight ? 'items-end' : 'items-start'}`} style={{ width: '100%' }}>
      <View style={{ width: alignRight ? '85%' : '100%' }}>
        <FileAttachmentsGrid
          filePaths={validAttachments}
          sandboxId={sandboxId}
          sandboxUrl={sandboxUrl}
          compact={false}
          showPreviews={true}
          onFilePress={onFilePress}
        />
      </View>
    </View>
  );
}

// Use shared preprocessTextOnlyTools function (imported above)
const preprocessTextOnlyToolsLocal = preprocessTextOnlyTools;

/**
 * Extract slide info from a create-slide tool result
 */
function extractSlideInfo(toolResult: { output?: any; success?: boolean } | undefined): SlideInfo | undefined {
  if (!toolResult) return undefined;

  try {
    const output = toolResult.output;
    if (!output) return undefined;

    // Handle string output (parse as JSON)
    let outputData = output;
    if (typeof output === 'string') {
      try {
        outputData = JSON.parse(output);
      } catch {
        return undefined;
      }
    }

    if (outputData?.presentation_name && outputData?.slide_number !== undefined) {
      return {
        presentationName: outputData.presentation_name,
        slideNumber: outputData.slide_number,
        slideTitle: outputData.slide_title || `Slide ${outputData.slide_number}`,
        totalSlides: outputData.total_slides || outputData.slide_number,
      };
    }
  } catch (e) {
    log.error('[extractSlideInfo] Error:', e);
  }
  return undefined;
}

interface ThreadContentProps {
  messages: UnifiedMessage[];
  streamingTextContent?: string;
  streamingReasoningContent?: string;
  isReasoningComplete?: boolean;
  streamingToolCall?: UnifiedMessage | null;
  agentStatus: 'idle' | 'running' | 'connecting' | 'error';
  handleToolClick?: (assistantMessageId: string | null, toolName: string, toolCallId?: string) => void;
  onFilePress?: (filePath: string) => void;
  onToolPress?: (toolMessages: ToolMessagePair[], initialIndex: number) => void;
  streamHookStatus?: string;
  sandboxId?: string;
  sandboxUrl?: string;
  onPromptFill?: (prompt: string) => void;
  isSendingMessage?: boolean;
  onRequestScroll?: () => void;
  isReconnecting?: boolean;
  retryCount?: number;
}

export const ThreadContent: React.FC<ThreadContentProps> = React.memo(
  ({
    messages,
    streamingTextContent = '',
    streamingReasoningContent = '',
    isReasoningComplete = false,
    streamingToolCall,
    agentStatus,
    handleToolClick,
    onFilePress,
    onToolPress,
    streamHookStatus = 'idle',
    sandboxId,
    sandboxUrl,
    onPromptFill,
    isSendingMessage = false,
    onRequestScroll,
    isReconnecting = false,
    retryCount = 0,
  }) => {
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const { agents } = useAgent();

    // State for reasoning expanded (persists across streaming/persisted transitions)
    const [reasoningExpanded, setReasoningExpanded] = React.useState(false);

    // Ref for reasoning content freezing (prevents flash during transitions)
    const lastReasoningContentRef = React.useRef<string>('');
    const prevAgentActiveRef = React.useRef(agentStatus === 'running' || agentStatus === 'connecting');

    // Determine if agent is currently active
    const isAgentActive = agentStatus === 'running' || agentStatus === 'connecting';

    // Update ref when reasoning content arrives
    React.useEffect(() => {
      if (streamingReasoningContent) {
        lastReasoningContentRef.current = streamingReasoningContent;
      }
    }, [streamingReasoningContent]);

    // Reasoning grace period: When agent starts, briefly delay showing text to allow reasoning to arrive first
    // This prevents the jarring experience of text appearing before the reasoning section
    const REASONING_GRACE_PERIOD_MS = 200;
    const [isInReasoningGracePeriod, setIsInReasoningGracePeriod] = React.useState(false);
    const gracePeriodTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Reset ref when agent starts a new turn
    React.useEffect(() => {
      const wasActive = prevAgentActiveRef.current;
      const isNowActive = isAgentActive;
      prevAgentActiveRef.current = isNowActive;

      // Agent just started - clear ref for fresh content and start grace period
      if (!wasActive && isNowActive) {
        lastReasoningContentRef.current = '';
        setReasoningExpanded(false);

        // Start reasoning grace period
        setIsInReasoningGracePeriod(true);
        if (gracePeriodTimeoutRef.current) {
          clearTimeout(gracePeriodTimeoutRef.current);
        }
        gracePeriodTimeoutRef.current = setTimeout(() => {
          setIsInReasoningGracePeriod(false);
          gracePeriodTimeoutRef.current = null;
        }, REASONING_GRACE_PERIOD_MS);
      }

      // Agent stopped - end grace period
      if (wasActive && !isNowActive) {
        setIsInReasoningGracePeriod(false);
        if (gracePeriodTimeoutRef.current) {
          clearTimeout(gracePeriodTimeoutRef.current);
          gracePeriodTimeoutRef.current = null;
        }
      }
    }, [isAgentActive]);

    // End grace period immediately when reasoning content arrives
    React.useEffect(() => {
      if (streamingReasoningContent && streamingReasoningContent.trim().length > 0 && isInReasoningGracePeriod) {
        setIsInReasoningGracePeriod(false);
        if (gracePeriodTimeoutRef.current) {
          clearTimeout(gracePeriodTimeoutRef.current);
          gracePeriodTimeoutRef.current = null;
        }
      }
    }, [streamingReasoningContent, isInReasoningGracePeriod]);

    // Cleanup timeout on unmount
    React.useEffect(() => {
      return () => {
        if (gracePeriodTimeoutRef.current) {
          clearTimeout(gracePeriodTimeoutRef.current);
        }
      };
    }, []);

    // Helper to render agent indicator based on agent type
    const renderAgentIndicator = useCallback((agentId: string | null | undefined) => {
      // Default Kortix agent or no agent ID - show full logomark
      const isKortixDefault = isKortixDefaultAgentId(agentId, agents);
      
      if (isKortixDefault) {
        // Full Kortix logomark (icon + text) - same height as symbol+text combo
        return <KortixLogo size={14} variant="logomark" color={isDark ? 'dark' : 'light'} />;
      }
      
      // Custom agent - show symbol + name
      const agent = agents.find(a => a.agent_id === agentId);
      const displayName = agent?.name || 'Agent';
      
      return (
        <View className="flex-row items-center gap-1.5">
          <KortixLogo size={16} variant="symbol" color={isDark ? 'dark' : 'light'} />
          <Text className="text-sm font-medium text-muted-foreground">{displayName}</Text>
        </View>
      );
    }, [isDark, agents]);

    // STREAMING OPTIMIZATION: Content now displays immediately as it arrives from the stream
    // Following frontend pattern - removed useSmoothText typewriter animation that was causing artificial delay
    // The old interface was also broken (wrong parameters and return type)
    const smoothStreamingText = streamingTextContent || '';
    const isSmoothAnimating = Boolean(streamingTextContent);

    // Extract ask/complete text from streaming tool call
    const rawAskCompleteText = useMemo(() => {
      if (!streamingToolCall) return '';
      
      const parsedMetadata = safeJsonParse<ParsedMetadata>(streamingToolCall.metadata, {});
      const toolCalls = parsedMetadata.tool_calls || [];
      const askOrCompleteTool = findAskOrCompleteTool(toolCalls);
      
      if (!askOrCompleteTool) return '';
      
      const toolArgs: any = askOrCompleteTool.arguments;
      if (!toolArgs) return '';
      
      return extractTextFromArguments(toolArgs);
    }, [streamingToolCall]);

    // Display ask/complete text immediately as it arrives (no artificial animation delay)
    const smoothAskCompleteText = rawAskCompleteText;
    const isAskCompleteAnimating = Boolean(rawAskCompleteText);

    const prevScrollTriggerLengthRef = React.useRef(0);
    const SCROLL_TRIGGER_CHARS = 80;
    React.useEffect(() => {
      const currentLength = (smoothStreamingText?.length || 0) + (smoothAskCompleteText?.length || 0);
      const charsSinceLastScroll = currentLength - prevScrollTriggerLengthRef.current;
      if (charsSinceLastScroll >= SCROLL_TRIGGER_CHARS && onRequestScroll) {
        onRequestScroll();
        prevScrollTriggerLengthRef.current = currentLength;
      }
    }, [smoothStreamingText, smoothAskCompleteText, onRequestScroll]);

    const displayMessages = useMemo(() => {
      const displayableTypes = ['user', 'assistant', 'tool', 'system', 'status', 'browser_state'];
      return messages.filter((msg) => displayableTypes.includes(msg.type));
    }, [messages]);

    const allToolMessages = useMemo(() => {
      const pairs: ToolMessagePair[] = [];
      const assistantMessages = messages.filter((m) => m.type === 'assistant');
      const toolMessages = messages.filter((m) => m.type === 'tool');

      const toolMap = new Map<string | null, UnifiedMessage[]>();
      toolMessages.forEach((toolMsg) => {
        const metadata = safeJsonParse<ParsedMetadata>(toolMsg.metadata, {});
        const assistantId = metadata.assistant_message_id || null;

        const parsed = parseToolMessage(toolMsg);
        const toolName = parsed?.toolName || '';

        if (toolName === 'ask' || toolName === 'complete') {
          return;
        }

        if (!toolMap.has(assistantId)) {
          toolMap.set(assistantId, []);
        }
        toolMap.get(assistantId)!.push(toolMsg);
      });

      assistantMessages.forEach((assistantMsg) => {
        const linkedTools = toolMap.get(assistantMsg.message_id || null);
        if (linkedTools && linkedTools.length > 0) {
          linkedTools.forEach((toolMsg) => {
            pairs.push({
              assistantMessage: assistantMsg,
              toolMessage: toolMsg,
            });
          });
        }
      });

      const orphanedTools = toolMap.get(null);
      if (orphanedTools) {
        orphanedTools.forEach((toolMsg) => {
          pairs.push({
            assistantMessage: assistantMessages[0] || null,
            toolMessage: toolMsg,
          });
        });
      }

      return pairs;
    }, [messages]);

    const groupedMessages = useMemo(() => {
      return groupMessagesWithStreaming(displayMessages, {
        streamingTextContent,
        streamingToolCall,
        readOnly: false,
        streamingText: undefined,
        isStreamingText: false,
      });
    }, [displayMessages, streamingTextContent, streamingToolCall]);

    if (
      displayMessages.length === 0 &&
      !streamingTextContent &&
      !streamingToolCall &&
      agentStatus === 'idle'
    ) {
      return (
        <View className="min-h-[60vh] flex-1 items-center justify-center">
          <Text className="text-center text-muted-foreground">Send a message to start.</Text>
        </View>
      );
    }

    const toolResultsMaps = useMemo(() => {
      const maps = new Map<string, Map<string | null, UnifiedMessage[]>>();

      groupedMessages.forEach((group) => {
        if (group.type === 'assistant_group') {
          const toolMessages = group.messages.filter((m) => m.type === 'tool');
          const map = new Map<string | null, UnifiedMessage[]>();

          toolMessages.forEach((toolMsg) => {
            const metadata = safeJsonParse<ParsedMetadata>(toolMsg.metadata, {});
            const assistantId = metadata.assistant_message_id || null;

            const parsed = parseToolMessage(toolMsg);
            const toolName = parsed?.toolName || '';

            if (toolName === 'ask' || toolName === 'complete') {
              return;
            }

            if (!map.has(assistantId)) {
              map.set(assistantId, []);
            }
            map.get(assistantId)!.push(toolMsg);
          });

          maps.set(group.key, map);
        }
      });

      return maps;
    }, [groupedMessages]);

    const { navigateToToolCall } = useKortixComputerStore();

    const handleToolPressInternal = useCallback(
      (clickedToolMsg: UnifiedMessage) => {
        const clickedIndex = allToolMessages.findIndex(
          (t) => t.toolMessage.message_id === clickedToolMsg.message_id
        );
        if (clickedIndex >= 0) {
          onToolPress?.(allToolMessages, clickedIndex);
          navigateToToolCall(clickedIndex);
        }
      },
      [allToolMessages, onToolPress, navigateToToolCall]
    );

    const handleStreamingToolCallPress = useCallback(
      (toolCall: any, assistantMessageId: string | null) => {
        if (!toolCall?.tool_call_id || !onToolPress) {
          return;
        }

        const existingToolMessage = messages.find((msg) => {
          if (msg.type !== 'tool') return false;
          const metadata = safeJsonParse<ParsedMetadata>(msg.metadata, {});
          return metadata.tool_call_id === toolCall.tool_call_id;
        });

        if (existingToolMessage) {
          // Tool message exists - find or create the pair
          const existingPair = allToolMessages.find(
            (pair) => pair.toolMessage.message_id === existingToolMessage.message_id
          );
          
          if (existingPair) {
            const clickedIndex = allToolMessages.findIndex(
              (p) => p.toolMessage.message_id === existingToolMessage.message_id
            );
            if (clickedIndex >= 0) {
              onToolPress(allToolMessages, clickedIndex);
              navigateToToolCall(clickedIndex);
            }
          } else {
            // Create pair from existing messages
            // Need to ensure assistant message has the specific tool call
            let assistantMsg = streamingToolCall || messages.find(
              (msg) => msg.message_id === assistantMessageId || 
                       (msg.type === 'assistant' && assistantMessageId === null)
            ) || null;
            
            // Get tool_call_id from the existing tool message
            const toolMetadata = safeJsonParse<ParsedMetadata>(existingToolMessage.metadata, {});
            const toolCallId = toolMetadata.tool_call_id;
            
            // Create focused assistant message with only the specific tool call
            if (assistantMsg && toolCallId) {
              const assistantMetadata = safeJsonParse<ParsedMetadata>(assistantMsg.metadata, {});
              const allToolCalls = assistantMetadata.tool_calls || [];
              const specificToolCall = allToolCalls.find((tc: any) => tc.tool_call_id === toolCallId);
              
              if (specificToolCall) {
                assistantMsg = {
                  ...assistantMsg,
                  metadata: JSON.stringify({
                    ...assistantMetadata,
                    tool_calls: [specificToolCall], // Only include the specific tool call
                  }),
                };
              } else if (streamingToolCall) {
                // Try streamingToolCall if main assistant message doesn't have it
                const streamingMetadata = safeJsonParse<ParsedMetadata>(streamingToolCall.metadata, {});
                const streamingToolCalls = streamingMetadata.tool_calls || [];
                const streamingSpecificToolCall = streamingToolCalls.find((tc: any) => tc.tool_call_id === toolCallId);
                
                if (streamingSpecificToolCall) {
                  assistantMsg = {
                    ...streamingToolCall,
                    metadata: JSON.stringify({
                      ...streamingMetadata,
                      tool_calls: [streamingSpecificToolCall],
                    }),
                  };
                }
              }
            }
            
            const newPair: ToolMessagePair = {
              assistantMessage: assistantMsg,
              toolMessage: existingToolMessage,
            };
            
            onToolPress([newPair], 0);
            navigateToToolCall(0);
          }
        } else if (toolCall.tool_result) {
          // Tool message doesn't exist yet - create synthetic tool message from streaming data
          // Find or create an assistant message with the specific tool call
          let assistantMsg = streamingToolCall || messages.find(
            (msg) => msg.message_id === assistantMessageId || 
                     (msg.type === 'assistant' && assistantMessageId === null)
          ) || null;

          // Ensure the assistant message has the specific tool call we need
          // extractToolCall() without toolCallId returns the first tool call,
          // so we need to create a focused assistant message with only this tool call
          if (assistantMsg) {
            const assistantMetadata = safeJsonParse<ParsedMetadata>(assistantMsg.metadata, {});
            const allToolCalls = assistantMetadata.tool_calls || [];
            const specificToolCall = allToolCalls.find((tc: any) => tc.tool_call_id === toolCall.tool_call_id);
            
            // If we found the specific tool call, create a focused assistant message with only this tool call
            if (specificToolCall) {
              assistantMsg = {
                ...assistantMsg,
                metadata: JSON.stringify({
                  ...assistantMetadata,
                  tool_calls: [specificToolCall], // Only include the specific tool call
                }),
              };
            } else if (streamingToolCall) {
              // Try streamingToolCall
              const streamingMetadata = safeJsonParse<ParsedMetadata>(streamingToolCall.metadata, {});
              const streamingToolCalls = streamingMetadata.tool_calls || [];
              const streamingSpecificToolCall = streamingToolCalls.find((tc: any) => tc.tool_call_id === toolCall.tool_call_id);
              
              if (streamingSpecificToolCall) {
                assistantMsg = {
                  ...streamingToolCall,
                  metadata: JSON.stringify({
                    ...streamingMetadata,
                    tool_calls: [streamingSpecificToolCall], // Only include the specific tool call
                  }),
                };
              }
            }
          } else if (streamingToolCall) {
            // Create focused assistant message from streamingToolCall
            const streamingMetadata = safeJsonParse<ParsedMetadata>(streamingToolCall.metadata, {});
            const streamingToolCalls = streamingMetadata.tool_calls || [];
            const specificToolCall = streamingToolCalls.find((tc: any) => tc.tool_call_id === toolCall.tool_call_id);
            
            if (specificToolCall) {
              assistantMsg = {
                ...streamingToolCall,
                metadata: JSON.stringify({
                  ...streamingMetadata,
                  tool_calls: [specificToolCall], // Only include the specific tool call
                }),
              };
            }
          }

          const toolResult = toolCall.tool_result;
          const resultOutput = toolResult?.output !== undefined 
            ? toolResult.output 
            : (typeof toolResult === 'object' && toolResult !== null && !toolResult.output && !toolResult.success
                ? toolResult
                : toolResult);
          const resultSuccess = toolResult?.success !== undefined 
            ? toolResult.success 
            : true;
          
          // Create content in legacy format for tools that might parse from content
          // Some tools parse from content, so include both formats
          const toolResultContent = {
            tool_name: toolCall.function_name?.replace(/_/g, '-') || 'unknown',
            parameters: typeof toolCall.arguments === 'string' 
              ? (() => { try { return JSON.parse(toolCall.arguments); } catch { return {}; } })()
              : (toolCall.arguments || {}),
            result: {
              output: resultOutput,
              success: resultSuccess,
            },
          };
          
          const syntheticToolMessage: UnifiedMessage = {
            type: 'tool',
            message_id: `streaming-tool-${toolCall.tool_call_id}`,
            content: JSON.stringify(toolResultContent),
            metadata: JSON.stringify({
              tool_call_id: toolCall.tool_call_id,
              function_name: toolCall.function_name,
              assistant_message_id: assistantMsg?.message_id || assistantMessageId,
              result: {
                output: resultOutput,
                success: resultSuccess,
              },
            }),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            thread_id: assistantMsg?.thread_id || '',
            sequence: Infinity,
            is_llm_message: false,
          };

          const syntheticPair: ToolMessagePair = {
            assistantMessage: assistantMsg,
            toolMessage: syntheticToolMessage,
          };
          
          onToolPress([syntheticPair], 0);
          navigateToToolCall(0);
        }
      },
      [messages, allToolMessages, onToolPress, navigateToToolCall, streamingToolCall]
    );

    return (
      <View className="flex-1 pt-4" pointerEvents="box-none">
        {groupedMessages.map((group, groupIndex) => {
          if (group.type === 'user') {
            const message = group.messages[0];
            const messageContent = (() => {
              try {
                const parsed = safeJsonParse<ParsedContent>(message.content, {
                  content: message.content,
                });
                const content = parsed.content || message.content;

                if (Array.isArray(content)) {
                  return content
                    .filter((item: any) => item.type === 'text' || typeof item === 'string')
                    .map((item: any) => (typeof item === 'string' ? item : item.text || ''))
                    .join('\n');
                }

                return typeof content === 'string' ? content : JSON.stringify(content || '');
              } catch {
                if (typeof message.content === 'string') {
                  return message.content;
                }
                const contentArray = message.content as any;
                if (Array.isArray(contentArray)) {
                  return contentArray
                    .filter((item: any) => item.type === 'text' || typeof item === 'string')
                    .map((item: any) => (typeof item === 'string' ? item : item.text || ''))
                    .join('\n');
                }
                return JSON.stringify(message.content || '');
              }
            })();

            // Match all attachment formats:
            // 1. [Uploaded File: path] - from existing thread uploads
            // 2. [Attached: filename (size) -> path] - from new thread creation with files
            // 3. [Pending Attachment: name] - optimistic messages (local URIs in metadata)
            const uploadedFileMatches = messageContent.match(/\[Uploaded File: (.*?)\]/g) || [];
            const attachedFileMatches = messageContent.match(/\[Attached: .*? -> (.*?)\]/g) || [];
            
            const attachments = [
              ...uploadedFileMatches.map((match: string) => {
                const pathMatch = match.match(/\[Uploaded File: (.*?)\]/);
                return pathMatch ? pathMatch[1] : null;
              }),
              ...attachedFileMatches.map((match: string) => {
                const pathMatch = match.match(/\[Attached: .*? -> (.*?)\]/);
                return pathMatch ? pathMatch[1] : null;
              }),
            ].filter(Boolean);

            // Parse pending attachments from metadata (for optimistic messages)
            let pendingAttachments: Array<{ uri: string; name: string; type: string; size?: number; status?: string }> = [];
            try {
              const metadata = typeof message.metadata === 'string' 
                ? JSON.parse(message.metadata) 
                : message.metadata;
              if (metadata?.pendingAttachments) {
                pendingAttachments = metadata.pendingAttachments;
              }
            } catch {
              // Ignore parse errors
            }

            const cleanContent = messageContent
              .replace(/\[Uploaded File: .*?\]/g, '')
              .replace(/\[Attached: .*? -> .*?\]/g, '')
              .replace(/\[Pending Attachment: .*?\]/g, '')
              .trim();

            return (
              <View key={group.key} className="mb-6">
                {/* Render pending attachments (local URIs from optimistic messages) */}
                {pendingAttachments.length > 0 && (
                  <View className="flex-row flex-wrap justify-end gap-2 mb-2">
                    {pendingAttachments.map((attachment, idx) => {
                      const isUploading = attachment.status !== 'ready';
                      return (
                        <View
                          key={`pending-${idx}`}
                          className="rounded-2xl overflow-hidden border border-border"
                          style={{ width: 120, height: 120 }}
                        >
                          {attachment.type === 'image' || attachment.type === 'video' ? (
                            <>
                              <Image
                                source={{ uri: attachment.uri }}
                                style={{ width: '100%', height: '100%' }}
                                resizeMode="cover"
                              />
                              {/* Uploading overlay - only show if still uploading */}
                              {isUploading && (
                                <View 
                                  className="absolute inset-0 bg-black/40 items-center justify-center"
                                  style={{ borderRadius: 16 }}
                                >
                                  <View className="bg-white/20 rounded-full p-2">
                                    <KortixLoader size="small" />
                                  </View>
                                </View>
                              )}
                            </>
                          ) : (
                            <View className="flex-1 items-center justify-center bg-card">
                              {isUploading && <KortixLoader size="small" />}
                              <Text className="text-xs text-muted-foreground text-center px-2 mt-2" numberOfLines={2}>
                                {attachment.name}
                              </Text>
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </View>
                )}

                {/* Render server-side attachments */}
                {renderStandaloneAttachments(
                  attachments as string[],
                  sandboxId,
                  sandboxUrl,
                  onFilePress,
                  true
                )}

                {cleanContent && (
                  <View className="flex-row justify-end">
                    <View
                      className="max-w-[90%] bg-card border border-border"
                      style={{
                        borderRadius: 24,
                        borderBottomRightRadius: 8,
                        overflow: 'hidden',
                      }}>
                      {ContextMenu ? (
                        <ContextMenu
                          actions={[{ title: 'Copy', systemIcon: 'doc.on.doc' }]}
                          onPress={async (e: any) => {
                            if (e.nativeEvent.index === 0) {
                              await Clipboard.setStringAsync(cleanContent);
                            }
                          }}
                          dropdownMenuMode={false}
                          borderTopLeftRadius={24}
                          borderTopRightRadius={24}
                          borderBottomLeftRadius={24}
                          borderBottomRightRadius={8}>
                          <View className="px-4 py-3">
                            <RNText
                              selectable
                              style={{
                                fontSize: 14,
                                lineHeight: 23,
                                fontFamily: 'Roobert-Regular',
                                color: isDark ? '#fafafa' : '#18181b',
                              }}>
                              {cleanContent}
                            </RNText>
                          </View>
                        </ContextMenu>
                      ) : (
                        <Pressable
                          onLongPress={async () => {
                            await Clipboard.setStringAsync(cleanContent);
                          }}
                          delayLongPress={500}>
                          <View className="px-4 py-3">
                            <RNText
                              selectable
                              style={{
                                fontSize: 14,
                                lineHeight: 23,
                                fontFamily: 'Roobert-Regular',
                                color: isDark ? '#fafafa' : '#18181b',
                              }}>
                              {cleanContent}
                            </RNText>
                          </View>
                        </Pressable>
                      )}
                    </View>
                  </View>
                )}
              </View>
            );
          }

          if (group.type === 'assistant_group') {
            // Skip rendering streaming groups when last message is user
            // because the trailing indicator handles streaming in that case
            const isStreamingGroup = group.key.startsWith('streaming-group');
            const lastMsgIsUser = messages[messages.length - 1]?.type === 'user';
            if (isStreamingGroup && lastMsgIsUser) {
              return null; // Trailing indicator handles this
            }
            
            const firstAssistantMsg = group.messages.find((m) => m.type === 'assistant');
            const groupAgentId = firstAssistantMsg?.agent_id;
            const assistantMessages = group.messages.filter((m) => m.type === 'assistant');
            const toolResultsMap = toolResultsMaps.get(group.key) || new Map();

            // Aggregate all text content from assistant messages for MessageActions (shown only at end)
            const aggregatedTextContent = (() => {
              const textParts: string[] = [];
              assistantMessages.forEach((msg) => {
                const meta = safeJsonParse<ParsedMetadata>(msg.metadata, {});
                if (meta.text_content) textParts.push(meta.text_content);
                // Also extract text from ask/complete tool calls
                const tcs = meta.tool_calls || [];
                tcs.forEach((tc: any) => {
                  const toolName = tc.function_name?.replace(/_/g, '-') || '';
                  if (toolName === 'ask' || toolName === 'complete') {
                    const args = typeof tc.arguments === 'string'
                      ? safeJsonParse(tc.arguments, {})
                      : (tc.arguments || {});
                    if (args.text) textParts.push(args.text);
                  }
                });
              });
              return textParts.join('\n\n');
            })();

            // Check if we're currently streaming (don't show actions while streaming)
            const isCurrentlyStreaming = streamHookStatus === 'streaming' || streamHookStatus === 'connecting';
            const isLastGroup = groupIndex === groupedMessages.length - 1;
            const isAgentRunning = agentStatus === 'running' || agentStatus === 'connecting';

            // Extract persisted reasoning content from the first assistant message (like frontend)
            const persistedReasoningContent = (() => {
              const firstAssistant = group.messages.find((m) => m.type === 'assistant');
              if (!firstAssistant) return null;
              const meta = safeJsonParse<ParsedMetadata>(firstAssistant.metadata, {});
              return (meta as any).reasoning_content || null;
            })();

            // Determine reasoning content to display for this group
            const displayReasoningContent = isLastGroup
              ? (streamingReasoningContent || lastReasoningContentRef.current || '')
              : '';
            const hasStreamingReasoningContent = displayReasoningContent.trim().length > 0;

            // Calculate reasoning section to show (same pattern as frontend)
            const reasoningSectionElement = (() => {
              // For last group: prefer streaming content, fall back to persisted
              if (isLastGroup && messages[messages.length - 1]?.type !== 'user') {
                if (hasStreamingReasoningContent) {
                  // If agent is idle and we have persisted reasoning, use persisted
                  const usePersistedInstead = !isCurrentlyStreaming && !isAgentRunning && persistedReasoningContent;

                  if (usePersistedInstead) {
                    return (
                      <ReasoningSection
                        content={persistedReasoningContent}
                        isStreaming={false}
                        isReasoningActive={false}
                        isReasoningComplete={true}
                        isPersistedContent={true}
                        isExpanded={reasoningExpanded}
                        onExpandedChange={setReasoningExpanded}
                      />
                    );
                  }

                  return (
                    <ReasoningSection
                      content={displayReasoningContent}
                      isStreaming={isCurrentlyStreaming}
                      isReasoningActive={isAgentRunning}
                      isReasoningComplete={isReasoningComplete}
                      isPersistedContent={false}
                      isExpanded={reasoningExpanded}
                      onExpandedChange={setReasoningExpanded}
                    />
                  );
                }
              }

              // For all groups: show persisted reasoning if it exists
              if (persistedReasoningContent) {
                return (
                  <ReasoningSection
                    content={persistedReasoningContent}
                    isStreaming={false}
                    isReasoningActive={false}
                    isReasoningComplete={true}
                    isPersistedContent={true}
                    isExpanded={reasoningExpanded}
                    onExpandedChange={setReasoningExpanded}
                  />
                );
              }

              return null;
            })();

            return (
              <View key={group.key} className="mb-6">
                {/* Reasoning section with integrated Kortix icon (like frontend) */}
                {reasoningSectionElement}
                {/* Show agent header only when reasoning section is NOT displayed */}
                {!reasoningSectionElement && (
                  <View className="mb-3 flex-row items-center">
                    {renderAgentIndicator(groupAgentId)}
                  </View>
                )}

                <View className="gap-3">
                  {assistantMessages.map((message, msgIndex) => {
                    const msgKey = message.message_id || `submsg-assistant-${msgIndex}`;

                    // Parse metadata to check for tool calls and text content
                    const metadata = safeJsonParse<ParsedMetadata>(message.metadata, {});
                    const toolCalls = metadata.tool_calls || [];
                    let textContent = metadata.text_content || '';

                    // Skip if no content (no text and no tool calls)
                    if (!textContent && toolCalls.length === 0) {
                      // Fallback: try parsing content for legacy messages
                      const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
                      if (!parsedContent.content) return null;
                    }

                    const linkedTools = toolResultsMap.get(message.message_id || null);

                    // Check if this is the latest message (last assistant message in the last group)
                    const isLastAssistantMessage = msgIndex === assistantMessages.length - 1;
                    const isLatestMessage = isLastGroup && isLastAssistantMessage;

                    // Use metadata-based rendering (new approach)
                    const renderedContent = renderAssistantMessage({
                      message,
                      onToolClick: handleToolClick || (() => { }),
                      onFileClick: onFilePress,
                      sandboxId,
                      sandboxUrl,
                      isLatestMessage,
                      threadId: message.thread_id,
                      onPromptFill,
                      isDark, // Pass color scheme from parent
                    });

                    return (
                      <View key={msgKey}>
                        {renderedContent && <View className="gap-2">{renderedContent}</View>}

                        {linkedTools && linkedTools.length > 0 && (
                          <View className="mt-2 gap-2">
                            {linkedTools.map((toolMsg: UnifiedMessage, toolIdx: number) => {
                              // Check if this is a media generation tool
                              const parsed = parseToolMessage(toolMsg);
                              const toolName = parsed?.toolName?.replace(/_/g, '-') || '';
                              
                              if (toolName === 'image-edit-or-generate') {
                                // Render inline media generation with shimmer/image
                                return (
                                  <MediaGenerationInline
                                    key={`media-gen-${toolMsg.message_id || toolIdx}`}
                                    toolCall={{
                                      function_name: toolName,
                                      arguments: parsed?.arguments || {},
                                      tool_call_id: parsed?.toolCallId,
                                    }}
                                    toolResult={parsed?.result ? {
                                      output: parsed.result.output,
                                      success: parsed.result.success,
                                    } : undefined}
                                    onToolClick={() => handleToolPressInternal(toolMsg)}
                                    sandboxUrl={sandboxUrl}
                                  />
                                );
                              }
                              
                              // Handle create-slide tool with inline preview
                              if (toolName === 'create-slide') {
                                const slideInfo = extractSlideInfo(parsed?.result);
                                return (
                                  <View key={`slide-tool-${toolMsg.message_id || toolIdx}`}>
                                    <CompactToolCard
                                      message={toolMsg}
                                      onPress={() => handleToolPressInternal(toolMsg)}
                                    />
                                    {slideInfo && sandboxUrl && (
                                      <SlideInlineThumbnail
                                        slideInfo={slideInfo}
                                        sandboxUrl={sandboxUrl}
                                        onClick={() => handleToolPressInternal(toolMsg)}
                                        isLoading={!parsed?.result}
                                      />
                                    )}
                                  </View>
                                );
                              }

                              // Handle web-search and image-search with enhanced cards (favicons/thumbnails)
                              if (toolName === 'web-search' || toolName === 'image-search') {
                                return (
                                  <EnhancedToolCard
                                    key={`enhanced-tool-${toolMsg.message_id || toolIdx}`}
                                    message={toolMsg}
                                    onPress={() => handleToolPressInternal(toolMsg)}
                                  />
                                );
                              }

                              // Regular tool card for other tools
                              return (
                                <CompactToolCard
                                  key={`tool-${toolMsg.message_id || toolIdx}`}
                                  message={toolMsg}
                                  onPress={() => handleToolPressInternal(toolMsg)}
                                />
                              );
                            })}
                          </View>
                        )}
                      </View>
                    );
                  })}

                  {/* Render streaming text content (XML tool calls or regular text) */}
                  {/* NOTE: Only render here if last message is NOT user - otherwise trailing indicator handles it */}
                  {groupIndex === groupedMessages.length - 1 &&
                    (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') &&
                    (streamingTextContent || isSmoothAnimating) &&
                    messages[messages.length - 1]?.type !== 'user' && (
                      <View className="mt-2">
                        {(() => {
                          // Use raw content for tag detection
                          const rawContent = streamingTextContent || '';
                          // Use smooth content for display (character-by-character animation)
                          const displayContent = smoothStreamingText || '';

                          let detectedTag: string | null = null;
                          let tagStartIndex = -1;

                          const functionCallsIndex = rawContent.indexOf('<function_calls>');
                          if (functionCallsIndex !== -1) {
                            detectedTag = 'function_calls';
                            tagStartIndex = functionCallsIndex;
                          }

                          // For smooth display: get text before tag, but only show as much as smoothed
                          const textBeforeTag =
                            detectedTag && tagStartIndex >= 0
                              ? displayContent.substring(0, Math.min(displayContent.length, tagStartIndex))
                              : displayContent;
                          const processedTextBeforeTag =
                            preprocessTextOnlyToolsLocal(textBeforeTag);

                          return (
                            <View className="gap-3">
                              {processedTextBeforeTag.trim() && (
                                <SelectableMarkdownText isDark={isDark}>
                                  {autoLinkUrls(processedTextBeforeTag).replace(
                                    /<((https?:\/\/|mailto:)[^>\s]+)>/g,
                                    (_: string, url: string) => `[${url}](${url})`
                                  )}
                                </SelectableMarkdownText>
                              )}
                              {detectedTag && (
                                <StreamingToolCard content={rawContent.substring(tagStartIndex)} />
                              )}
                            </View>
                          );
                        })()}
                      </View>
                    )}

                  {/* Render streaming native tool call (ask/complete) */}
                  {/* NOTE: Only render here if last message is NOT user - otherwise trailing indicator handles it */}
                  {groupIndex === groupedMessages.length - 1 &&
                    streamingToolCall &&
                    messages[messages.length - 1]?.type !== 'user' &&
                    (() => {
                      // EARLY CHECK: If agent is idle and there's a persisted ask/complete,
                      // let the persisted message handle rendering via renderAssistantMessage
                      const hasPersistedAskComplete = group.messages.some(m => {
                        if (m.type !== 'assistant') return false;
                        const meta = safeJsonParse<ParsedMetadata>(m.metadata, {});
                        const tcs = meta.tool_calls || [];
                        return tcs.some((tc: any) => {
                          const tn = tc.function_name?.replace(/_/g, '-').toLowerCase() || '';
                          return tn === 'ask' || tn === 'complete';
                        });
                      });

                      if (!isCurrentlyStreaming && !isAgentRunning && hasPersistedAskComplete) {
                        return null;
                      }

                      // Check if this is ask/complete - render as text instead of tool indicator
                      const parsedMetadata = safeJsonParse<ParsedMetadata>(
                        streamingToolCall.metadata,
                        {}
                      );
                      const toolCalls = parsedMetadata.tool_calls || [];

                      const askOrCompleteTool = findAskOrCompleteTool(toolCalls);

                      // For ask/complete, render the text content directly
                      if (askOrCompleteTool) {
                        // Check if the last assistant message already has completed ask/complete
                        const currentGroupAssistantMessages = group.messages.filter(
                          (m) => m.type === 'assistant'
                        );

                        // CRITICAL: Check if the streaming message is already persisted
                        if (streamingToolCall?.message_id && currentGroupAssistantMessages.some(
                          (m) => m.message_id === streamingToolCall.message_id
                        )) {
                          return null;
                        }

                        const lastAssistantMessage =
                          currentGroupAssistantMessages.length > 0
                            ? currentGroupAssistantMessages[
                            currentGroupAssistantMessages.length - 1
                            ]
                            : null;
                        if (lastAssistantMessage) {
                          const lastMsgMetadata = safeJsonParse<ParsedMetadata>(
                            lastAssistantMessage.metadata,
                            {}
                          );
                          // If the last message already has ask/complete and is complete, skip
                          if (shouldSkipStreamingRender(lastMsgMetadata)) {
                            return null;
                          }

                          // Additional check: compare text lengths
                          const persistedToolCalls = lastMsgMetadata.tool_calls || [];
                          const persistedAskComplete = findAskOrCompleteTool(persistedToolCalls);
                          if (persistedAskComplete) {
                            const persistedText = extractTextFromArguments(persistedAskComplete.arguments);
                            const streamingText = extractTextFromArguments(askOrCompleteTool.arguments);
                            if (persistedText && persistedText.length >= streamingText.length) {
                              return null;
                            }
                          }
                        }

                        // Use pre-computed smooth ask/complete text
                        const toolName =
                          askOrCompleteTool.function_name?.replace(/_/g, '-').toLowerCase() || '';
                        const textToShow =
                          smoothAskCompleteText || (toolName === 'ask' ? 'Asking...' : 'Completing...');

                        return (
                          <View className="mt-2">
                            <SelectableMarkdownText isDark={isDark}>
                              {autoLinkUrls(textToShow).replace(
                                /<((https?:\/\/|mailto:)[^>\s]+)>/g,
                                (_: string, url: string) => `[${url}](${url})`
                              )}
                            </SelectableMarkdownText>
                          </View>
                        );
                      }

                      // For non-ask/complete tools, check if any tool calls exist
                      const isAskOrComplete = toolCalls.some((tc) =>
                        isAskOrCompleteTool(tc.function_name)
                      );

                      // Don't render tool call indicator for ask/complete - they're handled above
                      if (isAskOrComplete) {
                        return null;
                      }

                      // For other tools, render tool call indicators with spinning icon
                      // Render ALL tool calls (streaming + completed) - don't filter out completed ones
                      // The StreamingToolCallIndicator component handles completed state correctly
                      
                      const visibleToolCalls = toolCalls;

                      if (visibleToolCalls.length > 0) {
                        const assistantMsgId = streamingToolCall?.message_id || 
                          group.messages.find(m => m.type === 'assistant')?.message_id || 
                          null;
                        
                        return (
                          <View className="mt-2 gap-2">
                            {visibleToolCalls.map((tc: any, tcIndex: number) => {
                              const toolName = (tc.function_name || tc.name || '')?.replace(/_/g, '-');
                              const isCompleted = tc.completed === true || 
                                (tc.tool_result !== undefined && 
                                 tc.tool_result !== null &&
                                 (typeof tc.tool_result === 'object' || Boolean(tc.tool_result)));
                              
                              // Special handling for media generation tools - show inline with shimmer
                              if (toolName === 'image-edit-or-generate') {
                                return (
                                  <MediaGenerationInline
                                    key={tc.tool_call_id || `streaming-media-${tcIndex}`}
                                    toolCall={{
                                      function_name: toolName,
                                      arguments: typeof tc.arguments === 'string'
                                        ? (() => { try { return JSON.parse(tc.arguments); } catch { return {}; } })()
                                        : (tc.arguments || {}),
                                      tool_call_id: tc.tool_call_id,
                                    }}
                                    toolResult={isCompleted && tc.tool_result ? {
                                      output: tc.tool_result,
                                      success: tc.tool_result?.success !== false,
                                    } : undefined}
                                    onToolClick={() => isCompleted && handleStreamingToolCallPress(tc, assistantMsgId)}
                                    sandboxUrl={sandboxUrl}
                                  />
                                );
                              }

                              // Special handling for create-slide - show inline thumbnail when completed
                              if (toolName === 'create-slide') {
                                const toolResult = isCompleted && tc.tool_result ? {
                                  output: tc.tool_result?.output || tc.tool_result,
                                  success: tc.tool_result?.success !== false,
                                } : undefined;
                                const slideInfo = extractSlideInfo(toolResult);

                                return (
                                  <View key={tc.tool_call_id || `streaming-slide-${tcIndex}`}>
                                    <CompactStreamingToolCard
                                      toolCall={tc}
                                      toolName={toolName}
                                      onPress={isCompleted ? () => handleStreamingToolCallPress(tc, assistantMsgId) : undefined}
                                    />
                                    {isCompleted && slideInfo && sandboxUrl && (
                                      <SlideInlineThumbnail
                                        slideInfo={slideInfo}
                                        sandboxUrl={sandboxUrl}
                                        onClick={() => handleStreamingToolCallPress(tc, assistantMsgId)}
                                        isLoading={false}
                                      />
                                    )}
                                  </View>
                                );
                              }

                              return (
                                <CompactStreamingToolCard
                                  key={tc.tool_call_id || `streaming-tool-${tcIndex}`}
                                  toolCall={tc}
                                  toolName={toolName}
                                  onPress={isCompleted ? () => handleStreamingToolCallPress(tc, assistantMsgId) : undefined}
                                />
                              );
                            })}
                          </View>
                        );
                      }

                      return (
                        <View className="mt-2">
                          <CompactStreamingToolCard toolCall={null} toolName="" />
                        </View>
                      );
                    })()}

                  {/* Show loader when agent is running but not streaming, inside the last assistant group */}
                  {/* NOTE: Only render here if last message is NOT user - otherwise trailing indicator handles it */}
                  {groupIndex === groupedMessages.length - 1 &&
                    (agentStatus === 'running' || agentStatus === 'connecting') &&
                    !streamingTextContent &&
                    !streamingToolCall &&
                    !isSmoothAnimating &&
                    !smoothAskCompleteText &&
                    !isAskCompleteAnimating &&
                    (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') &&
                    messages[messages.length - 1]?.type !== 'user' &&
                    (() => {
                      // Check if any message in this group already has ASK or COMPLETE
                      const hasAskOrComplete = group.messages.some((msg) => {
                        if (msg.type !== 'assistant') return false;
                        try {
                          const metadata = safeJsonParse<ParsedMetadata>(msg.metadata, {});
                          const toolCalls = metadata.tool_calls || [];
                          return toolCalls.some((tc) => isAskOrCompleteTool(tc.function_name));
                        } catch {
                          return false;
                        }
                      });
                      return !hasAskOrComplete;
                    })() && (
                      <View className="mt-4">
                        <AgentLoader isReconnecting={isReconnecting} retryCount={retryCount} />
                      </View>
                    )}

                  {/* Message actions - show once at the end of the entire assistant block, only when done streaming */}
                  {!isLastGroup && aggregatedTextContent && (
                    <MessageActions text={aggregatedTextContent} />
                  )}
                  {isLastGroup && aggregatedTextContent && streamHookStatus !== 'streaming' && streamHookStatus !== 'connecting' && (
                    <MessageActions text={aggregatedTextContent} />
                  )}
                </View>
              </View>
            );
          }

          return null;
        })}

        {/* Show agent indicator when waiting for response OR streaming - ONLY when last message is user */}
        {/* This unified approach prevents the layout jump when transitioning from loading to streaming */}
        {(() => {
          const lastMsg = messages[messages.length - 1];
          
          // Only show this trailing indicator if the LAST message is a USER message
          // If last message is assistant, the loader/streaming is handled inside groupedMessages
          if (lastMsg?.type !== 'user') return null;
          
          const isAgentActive = agentStatus === 'running' || agentStatus === 'connecting';
          const hasStreamingContent = Boolean(streamingTextContent || streamingToolCall || streamingReasoningContent);
          const hasVisibleReasoning = Boolean(streamingReasoningContent || lastReasoningContentRef.current);
          const isStreaming = streamHookStatus === 'streaming' || streamHookStatus === 'connecting';

          // Show this indicator when:
          // 1. Sending message (contemplating)
          // 2. Agent active but no streaming yet (brewing ideas)
          // 3. Streaming content (render it HERE to prevent layout jump)
          if (!isSendingMessage && !isAgentActive && !hasStreamingContent) return null;
          
          // Contemplating = sending message, waiting for server (before agent starts)
          const isContemplating = isSendingMessage && !isAgentActive && !hasStreamingContent;
          
          // Check if we have ACTUAL visible streaming content to show
          // This prevents the shift from AgentLoader to empty streaming container
          const hasVisibleStreamingText = (() => {
            // During reasoning grace period, don't show text yet - allow reasoning to arrive first
            if (isInReasoningGracePeriod) return false;

            if (!streamingTextContent && !isSmoothAnimating) return false;
            const rawContent = streamingTextContent || '';
            const displayContent = smoothStreamingText || '';

            // Check for XML tags
            let detectedTag: string | null = null;
            let tagStartIndex = -1;
            const functionCallsIndex = rawContent.indexOf('<function_calls>');
            if (functionCallsIndex !== -1) {
              detectedTag = 'function_calls';
              tagStartIndex = functionCallsIndex;
            }

            // Has visible text before tag?
            const textBeforeTag = detectedTag && tagStartIndex >= 0
              ? displayContent.substring(0, Math.min(displayContent.length, tagStartIndex))
              : displayContent;
            const hasText = preprocessTextOnlyToolsLocal(textBeforeTag).trim().length > 0;

            // Has visible tag (tool card)?
            const hasTag = detectedTag !== null;

            return hasText || hasTag;
          })();
          
          // Brewing = agent is active but no VISIBLE content yet (including reasoning)
          // Keep showing AgentLoader until we have actual visible streaming content
          // During grace period, treat tool calls as not visible either
          const hasVisibleToolCall = streamingToolCall && !isInReasoningGracePeriod;
          const isBrewing = isAgentActive && !hasVisibleStreamingText && !hasVisibleToolCall && !hasVisibleReasoning;

          // Determine if we should show reasoning section
          const showReasoning = isStreaming && hasVisibleReasoning;

          return (
            <View className="mb-6">
              {/* Show agent header only when reasoning section is NOT displayed */}
              {/* ReasoningSection has its own Kortix logo, so we hide the header when showing reasoning */}
              {!showReasoning && (
                <View className="mb-3 flex-row items-center">
                  {renderAgentIndicator(null)}
                </View>
              )}

              {/* AgentLoader - show when contemplating/brewing but NOT when reasoning is visible */}
              {(isContemplating || isBrewing) && !hasVisibleReasoning && (
                <View className="h-6 justify-center overflow-hidden">
                  <AgentLoader isReconnecting={isReconnecting} retryCount={retryCount} />
                </View>
              )}

              {/* ReasoningSection - show when we have reasoning content */}
              {showReasoning && (
                <ReasoningSection
                  content={streamingReasoningContent || lastReasoningContentRef.current}
                  isStreaming={isStreaming}
                  isReasoningActive={isAgentActive}
                  isReasoningComplete={isReasoningComplete}
                  isExpanded={reasoningExpanded}
                  onExpandedChange={setReasoningExpanded}
                />
              )}
              
              {/* Streaming text content - only show when we have VISIBLE content */}
              {/* No mt-2 margin here - the h-6 loader container provides consistent spacing */}
              {isStreaming && hasVisibleStreamingText && (
                <View>
                  {(() => {
                    // Use raw content for tag detection
                    const rawContent = streamingTextContent || '';
                    // Use smooth content for display (character-by-character animation)
                    const displayContent = smoothStreamingText || '';

                    let detectedTag: string | null = null;
                    let tagStartIndex = -1;

                    const functionCallsIndex = rawContent.indexOf('<function_calls>');
                    if (functionCallsIndex !== -1) {
                      detectedTag = 'function_calls';
                      tagStartIndex = functionCallsIndex;
                    }

                    // For smooth display: get text before tag, but only show as much as smoothed
                    const textBeforeTag =
                      detectedTag && tagStartIndex >= 0
                        ? displayContent.substring(0, Math.min(displayContent.length, tagStartIndex))
                        : displayContent;
                    const processedTextBeforeTag = preprocessTextOnlyToolsLocal(textBeforeTag);

                    return (
                      <View className="gap-3">
                        {processedTextBeforeTag.trim() && (
                          <SelectableMarkdownText isDark={isDark}>
                            {autoLinkUrls(processedTextBeforeTag).replace(
                              /<((https?:\/\/|mailto:)[^>\s]+)>/g,
                              (_: string, url: string) => `[${url}](${url})`
                            )}
                          </SelectableMarkdownText>
                        )}
                        {detectedTag && (
                          <StreamingToolCard content={rawContent.substring(tagStartIndex)} />
                        )}
                      </View>
                    );
                  })()}
                </View>
              )}
              
              {/* Streaming tool call - render HERE to prevent layout jump */}
              {/* Hide during reasoning grace period to allow reasoning to appear first */}
              {isStreaming && streamingToolCall && !isInReasoningGracePeriod && (() => {
                const parsedMetadata = safeJsonParse<ParsedMetadata>(
                  streamingToolCall.metadata,
                  {}
                );
                const toolCalls = parsedMetadata.tool_calls || [];
                const askOrCompleteTool = findAskOrCompleteTool(toolCalls);

                if (askOrCompleteTool) {
                  // Use extractTextFromArguments to correctly extract 'text' field for ask/complete
                  const textToShow = extractTextFromArguments(askOrCompleteTool.arguments);
                  if (!textToShow) return null;

                  return (
                    <View className="mt-2">
                      <SelectableMarkdownText isDark={isDark}>
                        {autoLinkUrls(textToShow).replace(
                          /<((https?:\/\/|mailto:)[^>\s]+)>/g,
                          (_: string, url: string) => `[${url}](${url})`
                        )}
                      </SelectableMarkdownText>
                    </View>
                  );
                }

                // Filter out ask/complete tools.
                const visibleToolCalls = toolCalls.filter((tc: any) => {
                  return !isAskOrCompleteTool(tc.function_name);
                });

                if (visibleToolCalls.length === 0) {
                  return null;
                }

                return (
                  <View className="mt-2 gap-2">
                    {visibleToolCalls.map((tc: any, tcIndex: number) => {
                      const rawToolName = (tc.function_name || '').replace(/_/g, '-');
                      const displayToolName = getUserFriendlyToolName(tc.function_name);
                      const isCompleted = tc.completed === true ||
                        (tc.tool_result !== undefined &&
                         tc.tool_result !== null &&
                         (typeof tc.tool_result === 'object' || Boolean(tc.tool_result)));

                      // Handle create-slide with inline thumbnail
                      if (rawToolName === 'create-slide') {
                        const toolResult = isCompleted && tc.tool_result ? {
                          output: tc.tool_result?.output || tc.tool_result,
                          success: tc.tool_result?.success !== false,
                        } : undefined;
                        const slideInfo = extractSlideInfo(toolResult);

                        return (
                          <View key={tc.tool_call_id || `trailing-slide-${tcIndex}`}>
                            <CompactStreamingToolCard toolCall={tc} toolName={displayToolName} />
                            {isCompleted && slideInfo && sandboxUrl && (
                              <SlideInlineThumbnail
                                slideInfo={slideInfo}
                                sandboxUrl={sandboxUrl}
                                onClick={() => {}}
                                isLoading={false}
                              />
                            )}
                          </View>
                        );
                      }

                      // Handle media generation
                      if (rawToolName === 'image-edit-or-generate') {
                        return (
                          <MediaGenerationInline
                            key={tc.tool_call_id || `trailing-media-${tcIndex}`}
                            toolCall={{
                              function_name: rawToolName,
                              arguments: typeof tc.arguments === 'string'
                                ? (() => { try { return JSON.parse(tc.arguments); } catch { return {}; } })()
                                : (tc.arguments || {}),
                              tool_call_id: tc.tool_call_id,
                            }}
                            toolResult={isCompleted && tc.tool_result ? {
                              output: tc.tool_result,
                              success: tc.tool_result?.success !== false,
                            } : undefined}
                            onToolClick={() => {}}
                            sandboxUrl={sandboxUrl}
                          />
                        );
                      }

                      return (
                        <CompactStreamingToolCard
                          key={tc.tool_call_id || `trailing-tool-${tcIndex}`}
                          toolCall={tc}
                          toolName={displayToolName}
                        />
                      );
                    })}
                  </View>
                );
              })()}
            </View>
          );
        })()}

        <View className="h-2" />
      </View>
    );
  }
);

ThreadContent.displayName = 'ThreadContent';
