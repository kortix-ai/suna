/**
 * Message Renderer - Clean chat message display
 */

import React, { useMemo, useCallback, useEffect, useRef } from 'react';
import { View, Pressable, Linking, Text as RNText, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import type { UnifiedMessage, ParsedContent, ParsedMetadata } from '@/api/types';
import { groupMessages, safeJsonParse, type MessageGroup } from '@/lib/utils/message-grouping';
import { 
  parseToolMessage, 
  formatToolOutput, 
  stripXMLTags,
  preprocessTextOnlyTools,
  parseXmlToolCalls,
  isNewXmlFormat,
  HIDE_STREAMING_XML_TAGS,
  detectAndStripPartialXML,
  STREAMABLE_TOOLS,
  extractStreamingContent
} from '@/lib/utils/tool-parser';
import { getToolIcon, getUserFriendlyToolName } from '@/lib/utils/tool-display';
import { AlertCircle, CheckCircle2, type LucideIcon } from 'lucide-react-native';
import Markdown from 'react-native-markdown-display';
import { markdownStyles, markdownStylesDark } from '@/lib/utils/markdown-styles';
import { useColorScheme } from 'nativewind';
import { AgentIdentifier } from '@/components/agents';
import { 
  FileAttachmentsGrid, 
  extractFileReferences, 
  removeFileReferences 
} from './FileAttachmentRenderer';
import { AgentLoader } from './AgentLoader';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withRepeat, 
  withSequence, 
  withTiming, 
  withDelay 
} from 'react-native-reanimated';

export interface ToolMessagePair {
  assistantMessage: UnifiedMessage | null;
  toolMessage: UnifiedMessage;
}

interface MessageRendererProps {
  messages: UnifiedMessage[];
  streamingContent?: string;
  streamingToolCall?: ParsedContent | null;
  isStreaming?: boolean;
  onToolPress?: (toolMessages: ToolMessagePair[], initialIndex: number) => void;
}

export const MessageRenderer = React.memo(function MessageRenderer({
  messages,
  streamingContent,
  streamingToolCall,
  isStreaming = false,
  onToolPress,
}: MessageRendererProps) {
  const processedStreamingContent = useMemo(() => {
    if (!streamingContent || !streamingContent.trim()) return '';
    
    let processed = streamingContent;
    
    if (processed.includes('<function_calls>')) {
      const beforeFunctionCalls = processed.split('<function_calls>')[0];
      processed = beforeFunctionCalls;
    }
    
    processed = preprocessTextOnlyTools(processed);
    processed = detectAndStripPartialXML(processed);
    
    return processed.trim();
  }, [streamingContent]);

  const groupedMessages = useMemo(() => {
    let messagesToRender = [...messages];
    
    if (processedStreamingContent) {
      const recentAssistantMsg = [...messages].reverse().find(m => m.type === 'assistant');
      const agentId = recentAssistantMsg?.agent_id || undefined;
      
      messagesToRender.push({
        message_id: 'streaming-assistant',
        thread_id: 'streaming',
        type: 'assistant',
        agent_id: agentId,
        is_llm_message: true,
        content: JSON.stringify({ role: 'assistant', content: processedStreamingContent }),
        metadata: JSON.stringify({ stream_status: 'streaming' }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    return groupMessages(messagesToRender);
  }, [messages, processedStreamingContent]);

  const allToolMessages = useMemo(() => {
    const pairs: ToolMessagePair[] = [];
    const assistantMessages = messages.filter(m => m.type === 'assistant');
    const toolMessages = messages.filter(m => m.type === 'tool');

    const toolMap = new Map<string | null, UnifiedMessage[]>();
    toolMessages.forEach(toolMsg => {
      const metadata = safeJsonParse<ParsedMetadata>(toolMsg.metadata, {});
      const assistantId = metadata.assistant_message_id || null;
      
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
    
    console.log('🔧 [MessageRenderer] Collected all tool messages:', pairs.length);
    return pairs;
  }, [messages]);

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const shouldShowInitialLoader = isStreaming && !processedStreamingContent && !streamingToolCall && 
    (messages.length === 0 || lastMessage?.type === 'user');

  return (
    <View className="flex-1 pt-4">
      {groupedMessages.map((group, index) => {
        const isLastGroup = index === groupedMessages.length - 1;
        
        if (group.type === 'user') {
          return (
            <UserMessageBubble 
              key={group.key} 
              message={group.message}
              isLast={isLastGroup}
            />
          );
        } else {
          return (
            <AssistantMessageGroup
              key={group.key}
              messages={group.messages}
              streamingToolCall={streamingToolCall}
              onToolPress={onToolPress}
              allToolMessages={allToolMessages}
              isLast={isLastGroup}
              isStreaming={isStreaming}
              hasStreamingContent={!!processedStreamingContent}
              streamingContent={streamingContent}
            />
          );
        }
      })}
      {streamingToolCall && groupedMessages.length > 0 && (() => {
        const lastGroup = groupedMessages[groupedMessages.length - 1];
        if (lastGroup.type === 'assistant_group') {
          return null;
        }
        return (
          <View className="px-4 mb-2.5">
            <ToolCard 
              isLoading 
              toolCall={streamingToolCall}
              streamingContent={streamingContent}
            />
          </View>
        );
      })()}
      
      {/* Initial loading state - when agent starts with no content yet */}
      {shouldShowInitialLoader && (
        <View className="px-4">
          <View className="mb-2">
            <AgentIdentifier 
              agentId={lastMessage?.agent_id} 
              size={16} 
              showName 
              textSize="base"
            />
          </View>
          <AgentLoader />
        </View>
      )}
    </View>
  );
});

/**
 * User Message Bubble
 */
const UserMessageBubble = React.memo(function UserMessageBubble({ 
  message, 
  isLast 
}: { 
  message: UnifiedMessage;
  isLast: boolean;
}) {
  const content = useMemo(() => {
    const parsed = safeJsonParse<ParsedContent>(message.content, {});
    
    if (typeof parsed.content === 'string') {
      return parsed.content;
    }
    
    if (parsed.content && typeof parsed.content === 'object' && 'text' in parsed.content) {
      return (parsed.content as any).text || '';
    }
    
    if (parsed.content && typeof parsed.content === 'object') {
      return JSON.stringify(parsed.content);
    }
    
    if (typeof parsed === 'string') {
      return parsed;
    }
    
    return '';
  }, [message.content]);

  // Extract file references from content
  const fileReferences = useMemo(() => extractFileReferences(content), [content]);
  const cleanContent = useMemo(() => removeFileReferences(content), [content]);

  const { colorScheme } = useColorScheme();
  
  // ✨ Dark bubble in dark mode, light bubble in light mode (matching Figma)
  // Use inline styles ONLY to avoid Tailwind conflicts
  const containerStyle = {
    maxWidth: '80%' as const,
  };
  
  const bubbleStyle = {
    backgroundColor: colorScheme === 'dark' ? '#161618' : '#f8f8f8',
    borderWidth: 1.5,
    borderColor: colorScheme === 'dark' ? '#232324' : '#e5e5e5',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
  };
  
  const textStyle = {
    color: colorScheme === 'dark' ? '#f8f8f8' : '#121215',
    fontSize: 16,
    lineHeight: 24,
  };
  
  return (
    <View className={`px-4 ${isLast ? 'mb-0' : 'mb-6'}`}>
      {/* File Attachments - Render outside bubble */}
      {fileReferences.length > 0 && (
        <View className="mb-2">
          <FileAttachmentsGrid
            filePaths={fileReferences}
            compact
          />
        </View>
      )}

      {/* Message Bubble */}
      {cleanContent.trim() && (
        <View className="flex-row justify-end">
          <View style={[containerStyle, bubbleStyle]}>
            <Text style={textStyle} selectable>
              {cleanContent}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
});

/**
 * Assistant Message Group
 */
const AssistantMessageGroup = React.memo(function AssistantMessageGroup({
  messages,
  streamingToolCall,
  onToolPress,
  allToolMessages,
  isLast,
  isStreaming,
  hasStreamingContent,
  streamingContent,
}: {
  messages: UnifiedMessage[];
  streamingToolCall?: ParsedContent | null;
  onToolPress?: (toolMessages: ToolMessagePair[], initialIndex: number) => void;
  allToolMessages: ToolMessagePair[];
  isLast: boolean;
  isStreaming: boolean;
  hasStreamingContent: boolean;
  streamingContent?: string;
}) {
  // Build map of tools linked to their calling assistant messages
  const { assistantMessages, toolResultsMap } = useMemo(() => {
    const assistants = messages.filter(m => m.type === 'assistant');
    const tools = messages.filter(m => m.type === 'tool');
    
    const map = new Map<string | null, UnifiedMessage[]>();
    tools.forEach(toolMsg => {
      const metadata = safeJsonParse<ParsedMetadata>(toolMsg.metadata, {});
      const assistantId = metadata.assistant_message_id || null;
      
      if (!map.has(assistantId)) {
        map.set(assistantId, []);
      }
      map.get(assistantId)!.push(toolMsg);
    });

    return { assistantMessages: assistants, toolResultsMap: map };
  }, [messages]);

  const handleToolPress = useCallback((clickedToolMsg: UnifiedMessage) => {
    // Find the index in the ENTIRE thread's tool messages, not just this group
    const clickedIndex = allToolMessages.findIndex(
      t => t.toolMessage.message_id === clickedToolMsg.message_id
    );
    console.log('🎯 [MessageRenderer] Tool clicked:', {
      toolId: clickedToolMsg.message_id,
      indexInThread: clickedIndex,
      totalToolsInThread: allToolMessages.length,
    });
    onToolPress?.(allToolMessages, clickedIndex >= 0 ? clickedIndex : 0);
  }, [allToolMessages, onToolPress]);

  // Get agent_id from first assistant message for the group identifier
  const firstAssistantMessage = assistantMessages[0];

  return (
    <View className={isLast ? 'mb-0' : 'mb-6'}>
      {/* Agent identifier - ONCE per group */}
      {firstAssistantMessage && (
        <View className="px-4 mb-2">
          <AgentIdentifier 
            agentId={firstAssistantMessage.agent_id} 
            size={16} 
            showName 
            textSize="base"
          />
        </View>
      )}

      {/* All assistant messages and their tools */}
      {assistantMessages.map((assistantMsg, idx) => {
        const linkedTools = toolResultsMap.get(assistantMsg.message_id || null);
        
        return (
          <View key={`${assistantMsg.message_id || 'assistant'}-${idx}-${assistantMsg.created_at}`}>
            <AssistantMessageContent 
              message={assistantMsg}
              hasToolsBelow={!!linkedTools && linkedTools.length > 0}
            />
            
            {/* Linked tool calls - comfortable spacing */}
            {linkedTools && linkedTools.length > 0 && (
              <View className="gap-2.5">
                {linkedTools.map((toolMsg, toolIdx) => (
                  <View key={`${toolMsg.message_id || 'tool'}-${toolIdx}-${toolMsg.created_at}`} className="px-4 mb-2.5">
                    <ToolCard
                      message={toolMsg}
                      onPress={() => handleToolPress(toolMsg)}
                    />
                  </View>
                ))}
              </View>
            )}
            
            {/* Streaming tool call - render as part of this assistant's tools */}
            {streamingToolCall && idx === assistantMessages.length - 1 && (
              <View className="px-4 mb-2.5">
                <ToolCard 
                  isLoading 
                  toolCall={streamingToolCall}
                  streamingContent={streamingContent}
                />
              </View>
            )}
            
            {/* Loading state after tool execution - like web version */}
            {isStreaming && !hasStreamingContent && !streamingToolCall && 
             linkedTools && linkedTools.length > 0 && 
             idx === assistantMessages.length - 1 && (
              <View className="px-4 mt-2">
                <AgentLoader />
              </View>
            )}
          </View>
        );
      })}
      
      {/* Orphaned tools */}
      {toolResultsMap.get(null)?.map((toolMsg, idx) => (
        <View key={`${toolMsg.message_id || 'orphan-tool'}-${idx}-${toolMsg.created_at}`} className="px-4 mt-2">
          <ToolCard
            message={toolMsg}
            onPress={() => handleToolPress(toolMsg)}
          />
        </View>
      ))}
    </View>
  );
});

/**
 * Assistant Message Content - Clean markdown rendering with native text selection
 * Now with file attachment support and proper function_calls handling
 */
const AssistantMessageContent = React.memo(function AssistantMessageContent({ 
  message,
  hasToolsBelow 
}: { 
  message: UnifiedMessage;
  hasToolsBelow: boolean;
}) {
  const { colorScheme } = useColorScheme();
  
  const { content, fileAttachments, sandboxId, isStreaming } = useMemo(() => {
    const parsed = safeJsonParse<ParsedContent>(message.content, {});
    const rawContent = parsed.content || '';
    
    const metadata = safeJsonParse<ParsedMetadata>(message.metadata, {});
    const streaming = message.message_id === 'streaming-assistant';
    
    if (streaming) {
      const files = extractFileReferences(rawContent);
      const cleanContent = removeFileReferences(rawContent);
      const sandbox = metadata.sandbox_id;
      
      return { 
        content: cleanContent || null, 
        fileAttachments: files,
        sandboxId: sandbox,
        isStreaming: true,
      };
    }
    
    let contentToProcess = rawContent;
    
    if (rawContent.includes('<function_calls>')) {
      const beforeFunctionCalls = rawContent.split('<function_calls>')[0].trim();
      contentToProcess = beforeFunctionCalls;
    }
    
    const files = extractFileReferences(contentToProcess);
    let cleanContent = removeFileReferences(contentToProcess);
    
    cleanContent = preprocessTextOnlyTools(cleanContent);
    const finalContent = stripXMLTags(cleanContent).trim();
    
    const sandbox = metadata.sandbox_id;
    
    return { 
      content: finalContent || null, 
      fileAttachments: files,
      sandboxId: sandbox,
      isStreaming: false,
    };
  }, [message.content, message.metadata, message.message_id]);

  const selectableRules = useMemo(() => ({
    textgroup: (node: any, children: any) => (
      <RNText key={node.key} selectable>
        {children}
      </RNText>
    ),
  }), []);

  if (!content && fileAttachments.length === 0) return null;

  return (
    <View className={`px-4 ${hasToolsBelow ? 'mb-3' : 'mb-0'}`}>
      {fileAttachments.length > 0 && (
        <FileAttachmentsGrid
          filePaths={fileAttachments}
          sandboxId={sandboxId}
          compact={false}
        />
      )}
      
      {content && (
        <View>
          <Markdown
            style={colorScheme === 'dark' ? markdownStylesDark : markdownStyles}
            onLinkPress={(url) => {
              Linking.openURL(url).catch(console.error);
              return false;
            }}
            rules={selectableRules}
          >
            {content}
          </Markdown>
          {isStreaming && (
            <View className="inline-flex">
              <StreamingCursor />
            </View>
          )}
        </View>
      )}
    </View>
  );
});

/**
 * Tool Card
 */
const ToolCard = React.memo(function ToolCard({
  message,
  isLoading = false,
  toolCall,
  onPress,
  streamingContent,
}: {
  message?: UnifiedMessage;
  isLoading?: boolean;
  toolCall?: ParsedContent;
  onPress?: () => void;
  streamingContent?: string;
}) {
  // Parse completed tool data
  const completedData = useMemo(() => {
    if (!message || isLoading) return null;
    
    const parsed = parseToolMessage(message.content);
    if (!parsed) {
      return {
        toolName: 'Unknown Tool',
        displayName: 'Unknown Tool',
        resultPreview: 'Failed to parse',
        isError: true,
      };
    }
    
    return {
      toolName: parsed.toolName,
      displayName: getUserFriendlyToolName(parsed.toolName),
      resultPreview: formatToolOutput(parsed.result.output, 60),
      isError: !parsed.result.success,
    };
  }, [message, isLoading]);

  // Get loading tool data
  const loadingData = useMemo(() => {
    if (!isLoading || !toolCall) return null;
    
    const toolName = toolCall.function_name || toolCall.name || 'Tool';
    const displayName = getUserFriendlyToolName(toolName);
    
    return { toolName, displayName };
  }, [isLoading, toolCall]);

  const extractedStreamingContent = useMemo(() => {
    if (!isLoading || !streamingContent || !toolCall) return null;
    
    const toolName = toolCall.function_name || toolCall.name || 'Tool';
    const normalizedToolName = toolName.replace(/_/g, '-').toLowerCase();
    
    if (!STREAMABLE_TOOLS.has(normalizedToolName)) return null;
    
    return extractStreamingContent(streamingContent, normalizedToolName);
  }, [isLoading, streamingContent, toolCall]);

  const scrollViewRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (extractedStreamingContent && scrollViewRef.current) {
      scrollViewRef.current.scrollToEnd({ animated: true });
    }
  }, [extractedStreamingContent]);

  // Determine display data
  const toolName = isLoading 
    ? loadingData?.toolName || 'Tool'
    : completedData?.toolName || 'Tool';
  
  const displayName = isLoading 
    ? loadingData?.displayName || 'Tool'
    : completedData?.displayName || 'Tool';
  
  const resultText = isLoading 
    ? 'Executing...'
    : completedData?.resultPreview || '';
  
  const isError = completedData?.isError || false;
  
  const ToolIcon = getToolIcon(toolName);
  const { colorScheme } = useColorScheme();
  
  const iconColor = colorScheme === 'dark' ? '#d4d4d4' : '#404040';

  // Animated opacity for smooth transitions
  const contentOpacity = useSharedValue(1);
  
  useEffect(() => {
    if (isLoading) {
      contentOpacity.value = withTiming(0.8, { duration: 200 });
    } else {
      contentOpacity.value = withTiming(1, { duration: 300 });
    }
  }, [isLoading]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.value,
  }));

  const hasStreamingContent = extractedStreamingContent && extractedStreamingContent.trim();
  
  return (
    <View className={`${hasStreamingContent ? 'border border-neutral-200 dark:border-neutral-700/50 rounded-2xl overflow-hidden' : ''}`}>
      <Pressable
        onPress={isLoading ? undefined : onPress}
        disabled={isLoading}
        className={`${hasStreamingContent ? 'bg-neutral-200 dark:bg-neutral-800' : 'bg-neutral-200 dark:bg-muted/80 rounded-2xl'} border-[1px] border-neutral-200 dark:border-neutral-700/50 px-2 py-2 pr-4`}
      >
        <Animated.View style={animatedStyle}>
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <View className='rounded-full h-8 w-8 flex items-center justify-center bg-neutral-300 dark:bg-neutral-700'>
                <ToolIcon size={14} color={iconColor} />
              </View>
              <Text className="text-[14px] font-semibold text-foreground">
                {displayName}
              </Text>
            </View>
            {isError ? (
              <AlertCircle size={14} color={(colorScheme ?? 'light') === 'dark' ? '#f87171' : '#ef4444'} />
            ) : (
              <CheckCircle2 size={14} color={(colorScheme ?? 'light') === 'dark' ? '#4ade80' : '#22c55e'} />
            )}
          </View>
        </Animated.View>
      </Pressable>
      
      {hasStreamingContent && (
        <View className="border-t border-neutral-200 dark:border-neutral-700/50">
          <ScrollView 
            ref={scrollViewRef}
            className="max-h-[300px] bg-zinc-100 dark:bg-neutral-900"
            showsVerticalScrollIndicator={false}
          >
            <View className="p-3">
              <Text 
                className="text-xs text-foreground font-mono leading-5" 
                selectable
                style={{ fontFamily: 'monospace' }}
              >
                {extractedStreamingContent}
              </Text>
            </View>
          </ScrollView>
        </View>
      )}
    </View>
  );
});

/**
 * Streaming Cursor Animation - Like ChatGPT
 */
const StreamingCursor = React.memo(function StreamingCursor() {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 500 }),
        withTiming(1, { duration: 500 })
      ),
      -1,
      false
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View 
      style={[animatedStyle, { marginLeft: 2 }]} 
      className="w-0.5 h-5 bg-foreground" 
    />
  );
});
