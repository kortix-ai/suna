/**
 * Message Renderer
 * 
 * Vercel-level design with perfect spacing and visual hierarchy:
 * - User messages: Clean bubbles with generous spacing
 * - Assistant messages: Grouped tightly with minimal spacing for flow
 * - Tool cards: Elegant cards with proper visual weight
 * - Agent indicators: Subtle, consistent branding
 */

import React, { useMemo, useCallback, useEffect } from 'react';
import { View, Pressable, Linking, Text as RNText } from 'react-native';
import { Text } from '@/components/ui/text';
import type { UnifiedMessage, ParsedContent, ParsedMetadata } from '@/api/types';
import { groupMessages, safeJsonParse, type MessageGroup } from '@/lib/message-grouping';
import { parseToolMessage, formatToolOutput, stripXMLTags } from '@/lib/tool-parser';
import { Wrench, AlertCircle, CheckCircle2 } from 'lucide-react-native';
import Markdown from 'react-native-markdown-display';
import { markdownStyles, markdownStylesDark } from '@/lib/markdown-styles';
import { useColorScheme } from 'nativewind';
import { AgentIdentifier } from '@/components/agents';
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

/**
 * Main Message Renderer Component
 * 
 * Clean architecture with perfect spacing rhythm:
 * - 24px between different message groups (user ↔ assistant)
 * - 12px within assistant message groups for visual cohesion
 * - 8px between tool cards for subtle grouping
 */
export function MessageRenderer({
  messages,
  streamingContent,
  streamingToolCall,
  isStreaming = false,
  onToolPress,
}: MessageRendererProps) {
  const groupedMessages = useMemo(() => {
    // Deduplicate streaming messages
    const dedupedMessages = messages.reduce((acc: UnifiedMessage[], msg, idx) => {
      if (!msg.message_id) {
        const msgContent = safeJsonParse<ParsedContent>(msg.content, {}).content || '';
        const hasDuplicateAfter = messages.slice(idx + 1).some((laterMsg) => {
          if (!laterMsg.message_id) return false;
          const laterContent = safeJsonParse<ParsedContent>(laterMsg.content, {}).content || '';
          return laterContent === msgContent || laterContent.includes(msgContent);
        });
        
        if (hasDuplicateAfter) return acc;
      }
      
      acc.push(msg);
      return acc;
    }, []);
    
    // Add streaming content as temporary message
    if (streamingContent) {
      dedupedMessages.push({
        message_id: null,
        thread_id: 'streaming',
        type: 'assistant',
        is_llm_message: true,
        content: JSON.stringify({ role: 'assistant', content: streamingContent }),
        metadata: JSON.stringify({ stream_status: 'chunk' }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    return groupMessages(dedupedMessages);
  }, [messages, streamingContent]);

  // Collect ALL tool messages from the ENTIRE thread for navigation
  const allToolMessages = useMemo(() => {
    const pairs: ToolMessagePair[] = [];
    const assistantMessages = messages.filter(m => m.type === 'assistant');
    const toolMessages = messages.filter(m => m.type === 'tool');
    
    // Map tools to their assistant messages
    const toolMap = new Map<string | null, UnifiedMessage[]>();
    toolMessages.forEach(toolMsg => {
      const metadata = safeJsonParse<ParsedMetadata>(toolMsg.metadata, {});
      const assistantId = metadata.assistant_message_id || null;
      
      if (!toolMap.has(assistantId)) {
        toolMap.set(assistantId, []);
      }
      toolMap.get(assistantId)!.push(toolMsg);
    });

    // Build pairs in chronological order
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
    
    // Add orphaned tools
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

  return (
    <View className="flex-1">
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
            />
          );
        }
      })}

      {/* Streaming indicators with proper spacing */}
      {streamingToolCall && (
        <View className="px-4 mb-2.5">
          <ToolCard isLoading toolCall={streamingToolCall} />
        </View>
      )}

      {isStreaming && (
        <View className="px-4 pb-3">
          <StreamingDots />
        </View>
      )}
    </View>
  );
}

/**
 * User Message Bubble
 * 
 * Design: Clean, rounded bubble aligned right
 * Spacing: Generous 24px bottom margin for clear separation
 */
function UserMessageBubble({ 
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

  if (!content) return null;

  const { colorScheme } = useColorScheme();
  
  return (
    <View className={`px-4 flex-row justify-end ${isLast ? 'mb-0' : 'mb-6'}`}>
      <View className="max-w-[80%] bg-primary rounded-[20px] px-4 py-3 shadow-sm">
        <Text 
          className="text-primary-foreground text-[15px] leading-[22px]"
          style={{ color: colorScheme === 'dark' ? '#121215' : '#f8f8f8' }}
          selectable
        >
          {content}
        </Text>
      </View>
    </View>
  );
}

/**
 * Assistant Message Group (Assistant + Linked Tools)
 * 
 * Design Philosophy:
 * - Agent identifier shown ONCE at the top of the group
 * - Agent identifier + message + tools flow as one cohesive unit
 * - Minimal spacing within group (tight coupling)
 * - Tools are visually subordinate but connected
 */
function AssistantMessageGroup({
  messages,
  streamingToolCall,
  onToolPress,
  allToolMessages,
  isLast,
}: {
  messages: UnifiedMessage[];
  streamingToolCall?: ParsedContent | null;
  onToolPress?: (toolMessages: ToolMessagePair[], initialIndex: number) => void;
  allToolMessages: ToolMessagePair[];
  isLast: boolean;
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
        <View className="px-4 mb-2.5">
          <AgentIdentifier 
            agentId={firstAssistantMessage.agent_id} 
            size={20} 
            showName 
            textSize="xs"
          />
        </View>
      )}

      {/* All assistant messages and their tools */}
      {assistantMessages.map((assistantMsg, idx) => {
        const linkedTools = toolResultsMap.get(assistantMsg.message_id || null);
        
        return (
          <View key={assistantMsg.message_id || `assistant-${idx}`}>
            <AssistantMessageContent 
              message={assistantMsg}
              hasToolsBelow={!!linkedTools && linkedTools.length > 0}
            />
            
            {/* Linked tool calls - comfortable spacing */}
            {linkedTools && linkedTools.length > 0 && (
              <View className="gap-2.5">
                {linkedTools.map((toolMsg, toolIdx) => (
                  <View key={toolMsg.message_id || `tool-${toolIdx}`} className="px-4 mb-2.5">
                    <ToolCard
                      message={toolMsg}
                      onPress={() => handleToolPress(toolMsg)}
                    />
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      })}
      
      {/* Orphaned tools */}
      {toolResultsMap.get(null)?.map((toolMsg, idx) => (
        <View key={toolMsg.message_id || `orphan-tool-${idx}`} className="px-4 mt-2">
          <ToolCard
            message={toolMsg}
            onPress={() => handleToolPress(toolMsg)}
          />
        </View>
      ))}
    </View>
  );
}

/**
 * Assistant Message Content
 * 
 * Design: Clean, left-aligned text without background
 * Note: Agent identifier is shown once per group (not per message)
 * Spacing: Minimal when tools follow, normal otherwise
 */
function AssistantMessageContent({ 
  message,
  hasToolsBelow 
}: { 
  message: UnifiedMessage;
  hasToolsBelow: boolean;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const { content, hasFunctionCalls, functionCallPreview } = useMemo(() => {
    const parsed = safeJsonParse<ParsedContent>(message.content, {});
    const rawContent = parsed.content || '';
    
    const hasFunctionCalls = rawContent.includes('<function_calls>');
    
    let functionCallPreview = 'Executing tool...';
    if (hasFunctionCalls) {
      const invokeMatch = rawContent.match(/<invoke name="([^"]+)">/);
      if (invokeMatch) {
        const toolName = invokeMatch[1];
        functionCallPreview = toolName
          .split('_')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
      }
    }
    
    const cleanContent = stripXMLTags(rawContent);
    
    return {
      content: cleanContent,
      hasFunctionCalls,
      functionCallPreview,
    };
  }, [message.content]);

  const handleLinkPress = useCallback((url: string) => {
    Linking.openURL(url).catch((err) => {
      console.error('[MessageRenderer] Failed to open link:', err);
    });
    return false;
  }, []);

  // Custom rules to make all text selectable using React Native's built-in selection
  const customRules = useMemo(() => ({
    text: (node: any, children: any, parent: any, styles: any) => (
      <RNText key={node.key} style={styles.text} selectable>
        {node.content}
      </RNText>
    ),
  }), []);

  // Don't render assistant messages that contain function calls
  // The tool cards will show all the necessary information
  if (hasFunctionCalls) return null;
  
  // Don't render if empty
  if (!content) return null;

  return (
    <View className={`px-4 ${hasToolsBelow ? 'mb-3' : 'mb-0'}`}>
      {/* Message content - full width, perfect typography with selectable text */}
      <View className="w-full">
        <Markdown
          style={isDark ? markdownStylesDark : markdownStyles}
          onLinkPress={handleLinkPress}
          rules={customRules}
        >
          {content}
        </Markdown>
      </View>
    </View>
  );
}

/**
 * Unified Tool Card Component
 * 
 * Design: Single component that handles both loading and completed states
 * Features: Smooth transitions, no flashing between states
 * States: loading (streaming) → completed (success/error)
 */
function ToolCard({
  message,
  isLoading = false,
  toolCall,
  onPress,
}: {
  message?: UnifiedMessage;
  isLoading?: boolean;
  toolCall?: ParsedContent;
  onPress?: () => void;
}) {
  // Parse completed tool data
  const completedData = useMemo(() => {
    if (!message || isLoading) return null;
    
    const parsed = parseToolMessage(message.content);
    if (!parsed) {
      return {
        toolName: 'Unknown Tool',
        resultPreview: 'Failed to parse',
        isError: true,
      };
    }
    
    return {
      toolName: parsed.toolName,
      resultPreview: formatToolOutput(parsed.result.output, 60),
      isError: !parsed.result.success,
    };
  }, [message, isLoading]);

  // Get loading tool data
  const loadingData = useMemo(() => {
    if (!isLoading || !toolCall) return null;
    
    const toolName = toolCall.function_name || toolCall.name || 'Tool';
    const displayName = toolName
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    
    return { displayName };
  }, [isLoading, toolCall]);

  // Determine display data
  const toolName = isLoading 
    ? loadingData?.displayName || 'Tool'
    : completedData?.toolName || 'Tool';
  
  const resultText = isLoading 
    ? 'Executing...'
    : completedData?.resultPreview || '';
  
  const isError = completedData?.isError || false;

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

  return (
    <Pressable
      onPress={isLoading ? undefined : onPress}
      disabled={isLoading}
      className={`bg-muted/30 rounded-xl px-3.5 py-3 border ${
        isLoading ? 'border-primary/30' : 'border-border/30'
      } ${!isLoading && 'active:bg-muted/50'}`}
    >
      <Animated.View style={animatedStyle}>
        <View className="flex-row items-center justify-between mb-1.5">
          <View className="flex-row items-center gap-2">
            {isLoading && (
              <View className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            )}
            <Wrench size={14} className="text-muted-foreground" />
            <Text className="text-[13px] font-semibold text-foreground">
              {toolName}
            </Text>
          </View>
          
          {/* Status indicator */}
          {isLoading ? (
            <View className="w-3.5 h-3.5 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin" />
          ) : isError ? (
            <AlertCircle size={14} color="#ef4444" />
          ) : (
            <CheckCircle2 size={14} color="#22c55e" />
          )}
        </View>
        
        <Text className="text-[13px] text-muted-foreground leading-[18px]" numberOfLines={2}>
          {resultText}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

/**
 * Streaming Dots Animation
 * 
 * Design: Elegant three-dot pulse showing active streaming
 * Position: Bottom of content, subtle and non-intrusive
 */
function StreamingDots() {
  const dot1Opacity = useSharedValue(0.3);
  const dot2Opacity = useSharedValue(0.3);
  const dot3Opacity = useSharedValue(0.3);

  useEffect(() => {
    dot1Opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 400 }),
        withTiming(0.3, { duration: 400 })
      ),
      -1,
      false
    );

    dot2Opacity.value = withDelay(
      133,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 400 }),
          withTiming(0.3, { duration: 400 })
        ),
        -1,
        false
      )
    );

    dot3Opacity.value = withDelay(
      266,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 400 }),
          withTiming(0.3, { duration: 400 })
        ),
        -1,
        false
      )
    );
  }, []);

  const dot1Style = useAnimatedStyle(() => ({ opacity: dot1Opacity.value }));
  const dot2Style = useAnimatedStyle(() => ({ opacity: dot2Opacity.value }));
  const dot3Style = useAnimatedStyle(() => ({ opacity: dot3Opacity.value }));

  return (
    <View className="flex-row gap-1 items-center">
      <Animated.View 
        style={[dot1Style]} 
        className="w-1.5 h-1.5 rounded-full bg-muted-foreground" 
      />
      <Animated.View 
        style={[dot2Style]} 
        className="w-1.5 h-1.5 rounded-full bg-muted-foreground" 
      />
      <Animated.View 
        style={[dot3Style]} 
        className="w-1.5 h-1.5 rounded-full bg-muted-foreground" 
      />
    </View>
  );
}
