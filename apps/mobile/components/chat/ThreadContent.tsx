import React, { useMemo, useCallback } from 'react';
import { View, Pressable, Linking, Text as RNText, TextInput, Platform, ScrollView } from 'react-native';
import * as Clipboard from 'expo-clipboard';

// Only import ContextMenu on native platforms (iOS/Android)
let ContextMenu: React.ComponentType<any> | null = null;
if (Platform.OS !== 'web') {
  try {
    ContextMenu = require('react-native-context-menu-view').default;
  } catch (e) {
    console.warn('react-native-context-menu-view not available');
  }
}
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import type { UnifiedMessage, ParsedContent, ParsedMetadata } from '@/api/types';
import { safeJsonParse } from '@/lib/utils/message-grouping';
import {
  parseXmlToolCalls,
  isNewXmlFormat,
  parseToolMessage,
  formatToolOutput,
  HIDE_STREAMING_XML_TAGS,
} from '@/lib/utils/tool-parser';
import { getToolIcon, getUserFriendlyToolName, getToolDisplayName } from '@/lib/utils/tool-display';
import {
  extractTextFromPartialJson,
  extractTextFromArguments,
  isAskOrCompleteTool,
  findAskOrCompleteTool,
  shouldSkipStreamingRender,
} from '@/lib/utils/streaming-utils';
import { useColorScheme } from 'nativewind';
import { SelectableMarkdownText } from '@/components/ui/selectable-markdown';
import { autoLinkUrls } from '@/lib/utils/url-autolink';
import { AgentIdentifier } from '@/components/agents';
import { FileAttachmentsGrid } from './FileAttachmentRenderer';
import { AgentLoader } from './AgentLoader';
import { ToolCallItem } from './ToolCallItem';
import { Loader2, Check, CheckCircle2, AlertCircle, Info, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { StreamingToolCard } from './StreamingToolCard';
import { TaskCompletedFeedback } from './tool-views/complete-tool/TaskCompletedFeedback';
import { renderAssistantMessage } from './assistant-message-renderer';
import { PromptExamples } from '@/components/shared';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';

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

function preprocessTextOnlyToolsLocal(content: string): string {
  if (!content || typeof content !== 'string') {
    return content || '';
  }

  content = content.replace(
    /<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi,
    (match) => {
      if (match.includes('<parameter name="attachments"')) return match;
      return match.replace(
        /<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi,
        '$1'
      );
    }
  );

  content = content.replace(
    /<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi,
    (match) => {
      if (match.includes('<parameter name="attachments"')) return match;
      return match.replace(
        /<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi,
        '$1'
      );
    }
  );

  content = content.replace(
    /<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)$/gi,
    (match) => {
      if (match.includes('<parameter name="attachments"')) return match;
      return match.replace(
        /<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)$/gi,
        '$1'
      );
    }
  );

  content = content.replace(
    /<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)$/gi,
    (match) => {
      if (match.includes('<parameter name="attachments"')) return match;
      return match.replace(
        /<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)$/gi,
        '$1'
      );
    }
  );

  content = content.replace(/<ask[^>]*>([\s\S]*?)<\/ask>/gi, (match) => {
    if (match.match(/<ask[^>]*attachments=/i)) return match;
    return match.replace(/<ask[^>]*>([\s\S]*?)<\/ask>/gi, '$1');
  });

  content = content.replace(/<complete[^>]*>([\s\S]*?)<\/complete>/gi, (match) => {
    if (match.match(/<complete[^>]*attachments=/i)) return match;
    return match.replace(/<complete[^>]*>([\s\S]*?)<\/complete>/gi, '$1');
  });
  return content;
}

interface MarkdownContentProps {
  content: string;
  handleToolClick?: (assistantMessageId: string | null, toolName: string, toolCallId?: string) => void;
  messageId?: string | null;
  threadId?: string;
  onFilePress?: (filePath: string) => void;
  sandboxId?: string;
  sandboxUrl?: string;
  isLatestMessage?: boolean;
  onPromptFill?: (prompt: string) => void;
}

const MarkdownContent = React.memo(function MarkdownContent({
  content,
  handleToolClick,
  messageId,
  threadId,
  onFilePress,
  sandboxId,
  sandboxUrl,
  isLatestMessage,
  onPromptFill,
}: MarkdownContentProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const processedContent = useMemo(() => {
    let processed = preprocessTextOnlyToolsLocal(content);

    processed = processed.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');

    const oldFormatToolTags = [
      'execute-command',
      'check-command-output',
      'terminate-command',
      'create-file',
      'delete-file',
      'str-replace',
      'edit-file',
      'full-file-rewrite',
      'read-file',
      'create-tasks',
      'update-tasks',
      'browser-navigate-to',
      'browser-act',
      'browser-extract-content',
      'browser-screenshot',
      'browser-click-element',
      'browser-close-tab',
      'browser-input-text',
      'web-search',
      'crawl-webpage',
      'scrape-webpage',
      'expose-port',
      'call-data-provider',
      'get-data-provider-endpoints',
      'create-sheet',
      'update-sheet',
      'view-sheet',
      'execute-code',
      'make-phone-call',
      'end-call',
      'designer-create-or-edit',
      'image-edit-or-generate',
    ];

    for (const tag of oldFormatToolTags) {
      const regex = new RegExp(`<${tag}[^>]*>.*?<\\/${tag}>|<${tag}[^>]*\\/>`, 'gis');
      processed = processed.replace(regex, '');
    }

    processed = processed.replace(/^\s*\n/gm, '');
    processed = processed.trim();

    // Auto-link plain URLs
    processed = autoLinkUrls(processed);

    return processed;
  }, [content]);

  if (isNewXmlFormat(processedContent)) {
    const contentParts: React.ReactNode[] = [];
    let lastIndex = 0;

    const functionCallsRegex = /<function_calls>([\s\S]*?)<\/function_calls>/gi;
    let match: RegExpExecArray | null = null;

    while ((match = functionCallsRegex.exec(processedContent)) !== null) {
      if (match.index > lastIndex) {
        const textBeforeBlock = processedContent.substring(lastIndex, match.index);
        if (textBeforeBlock.trim()) {
          contentParts.push(
            <View key={`md-${lastIndex}`}>
              <SelectableMarkdownText isDark={isDark}>
                {textBeforeBlock.replace(
                  /<((https?:\/\/|mailto:)[^>\s]+)>/g,
                  (_: string, url: string) => `[${url}](${url})`
                )}
              </SelectableMarkdownText>
            </View>
          );
        }
      }

      const toolCalls = parseXmlToolCalls(match[0]);

      toolCalls.forEach((toolCall, index) => {
        const toolName = toolCall.functionName.replace(/_/g, '-');

        if (toolName === 'ask') {
          const askText = toolCall.parameters.text || '';
          const attachments = toolCall.parameters.attachments || [];
          const followUpAnswers = toolCall.parameters.follow_up_answers || [];

          const attachmentArray = Array.isArray(attachments)
            ? attachments
            : typeof attachments === 'string'
              ? attachments.split(',').map((a) => a.trim())
              : [];
          const answersArray = Array.isArray(followUpAnswers)
            ? followUpAnswers
            : typeof followUpAnswers === 'string'
              ? followUpAnswers
                .split(',')
                .map((a) => a.trim())
                .filter(Boolean)
              : [];

          contentParts.push(
            <View key={`ask-${match?.index}-${index}`} className="gap-3">
              <SelectableMarkdownText isDark={isDark}>
                {autoLinkUrls(askText).replace(
                  /<((https?:\/\/|mailto:)[^>\s]+)>/g,
                  (_: string, url: string) => `[${url}](${url})`
                )}
              </SelectableMarkdownText>

              <View className="flex-row items-start gap-2.5 rounded-xl border border-border bg-muted/40 px-3 py-2.5 dark:bg-muted/20">
                <Icon as={Info} size={16} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
                <Text className="flex-1 font-roobert text-sm leading-relaxed text-muted-foreground">
                  Kortix will automatically continue working once you provide your response.
                </Text>
              </View>

              {/* Follow-up Answers - Suggested responses using shared PromptExamples */}
              {answersArray.length > 0 && (
                <PromptExamples
                  prompts={answersArray}
                  onPromptClick={onPromptFill}
                  title="Suggested responses"
                  showTitle={true}
                  maxPrompts={4}
                />
              )}
            </View>
          );

          const standaloneAttachments = renderStandaloneAttachments(
            attachmentArray,
            sandboxId,
            sandboxUrl,
            onFilePress
          );
          if (standaloneAttachments) {
            contentParts.push(
              <View key={`ask-func-attachments-${match?.index}-${index}`}>
                {standaloneAttachments}
              </View>
            );
          }
        } else if (toolName === 'complete') {
          const completeText = toolCall.parameters.text || '';
          const attachments = toolCall.parameters.attachments || '';
          const followUpPrompts = toolCall.parameters.follow_up_prompts || [];

          const attachmentArray = Array.isArray(attachments)
            ? attachments
            : typeof attachments === 'string'
              ? attachments.split(',').map((a) => a.trim())
              : [];
          const promptsArray = Array.isArray(followUpPrompts)
            ? followUpPrompts
            : typeof followUpPrompts === 'string'
              ? followUpPrompts
                .split(',')
                .map((a) => a.trim())
                .filter(Boolean)
              : [];

          contentParts.push(
            <View key={`complete-${match?.index}-${index}`} className="gap-3">
              <SelectableMarkdownText isDark={isDark}>
                {autoLinkUrls(completeText).replace(
                  /<((https?:\/\/|mailto:)[^>\s]+)>/g,
                  (_: string, url: string) => `[${url}](${url})`
                )}
              </SelectableMarkdownText>

              <TaskCompletedFeedback
                taskSummary={completeText}
                followUpPrompts={promptsArray.length > 0 ? promptsArray : undefined}
                threadId={threadId || ''}
                messageId={messageId || ''}
                samplePromptsTitle="Sample prompts"
                onFollowUpClick={(prompt) => {
                  console.log('📝 Inline follow-up clicked:', prompt);
                  onPromptFill?.(prompt);
                }}
              />
            </View>
          );

          const standaloneAttachments = renderStandaloneAttachments(
            attachmentArray,
            sandboxId,
            sandboxUrl,
            onFilePress
          );
          if (standaloneAttachments) {
            contentParts.push(
              <View key={`complete-func-attachments-${match?.index}-${index}`}>
                {standaloneAttachments}
              </View>
            );
          }
        } else {
          const IconComponent = getToolIcon(toolName);

          let paramDisplay = '';
          if (toolCall.parameters.file_path) {
            paramDisplay = toolCall.parameters.file_path;
          } else if (toolCall.parameters.command) {
            paramDisplay = toolCall.parameters.command;
          } else if (toolCall.parameters.query) {
            paramDisplay = toolCall.parameters.query;
          } else if (toolCall.parameters.url) {
            paramDisplay = toolCall.parameters.url;
          }
        }
      });

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < processedContent.length) {
      const remainingText = processedContent.substring(lastIndex);
      if (remainingText.trim()) {
        contentParts.push(
          <View key={`md-${lastIndex}`}>
            <SelectableMarkdownText isDark={isDark}>
              {remainingText.replace(
                /<((https?:\/\/|mailto:)[^>\s]+)>/g,
                (_: string, url: string) => `[${url}](${url})`
              )}
            </SelectableMarkdownText>
          </View>
        );
      }
    }

    return (
      <View>
        {contentParts.length > 0 ? (
          contentParts
        ) : (
          <SelectableMarkdownText isDark={isDark}>
            {processedContent.replace(
              /<((https?:\/\/|mailto:)[^>\s]+)>/g,
              (_: string, url: string) => `[${url}](${url})`
            )}
          </SelectableMarkdownText>
        )}
      </View>
    );
  }

  return (
    <SelectableMarkdownText isDark={isDark}>
      {processedContent.replace(
        /<((https?:\/\/|mailto:)[^>\s]+)>/g,
        (_: string, url: string) => `[${url}](${url})`
      )}
    </SelectableMarkdownText>
  );
});

/**
 * CompletedActionItem - A single completed action with tool-specific icon
 * Uses ToolCallItem component matching Figma design
 */
const CompletedActionItem = React.memo(function CompletedActionItem({
  message,
  onPress,
}: {
  message: UnifiedMessage;
  onPress?: () => void;
}) {
  const parsed = parseToolMessage(message);
  const toolName = parsed?.toolName || 'unknown';

  return (
    <ToolCallItem
      toolName={toolName}
      isComplete={true}
      isProcessing={false}
      onPress={onPress}
    />
  );
});

/**
 * CollapsibleToolActions - Groups multiple completed tool actions into a collapsible section
 * Matches Figma design with count, "Tool calls" text, and chevron icons
 */
const CollapsibleToolActions = React.memo(function CollapsibleToolActions({
  tools,
  onToolPress,
}: {
  tools: UnifiedMessage[];
  onToolPress?: (tool: UnifiedMessage) => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [isExpanded, setIsExpanded] = React.useState(false);
  const chevronRotation = useSharedValue(0);
  const scale = useSharedValue(1);

  const toggleExpanded = React.useCallback(() => {
    setIsExpanded((prev) => !prev);
    chevronRotation.value = withTiming(isExpanded ? 0 : 180, { duration: 200 });
  }, [isExpanded, chevronRotation]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronRotation.value}deg` }],
  }));

  const scaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const toolCount = tools.length;
  const toolText = toolCount === 1 ? 'Tool call' : 'Tool calls';

  return (
    <View className="py-2">
      {/* Collapsed/Expanded Header */}
      <Animated.View style={scaleStyle}>
        <Pressable
          onPress={toggleExpanded}
          onPressIn={() => {
            scale.value = withTiming(0.97, { duration: 100 });
          }}
          onPressOut={() => {
            scale.value = withTiming(1, { duration: 100 });
          }}
          style={{
            backgroundColor: isDark 
              ? 'rgba(64, 64, 64, 0.4)'
              : 'rgba(229, 229, 229, 0.4)',
            borderRadius: 16,
            paddingVertical: 12,
            paddingHorizontal: 12,
          }}
          className="flex-row items-center"
          hitSlop={8}
        >
          <Text 
            className="text-base font-roobert-medium text-neutral-900 dark:text-neutral-50 text-center min-w-[20px]"
            style={{ opacity: 0.6 }}
          >
            {toolCount}
          </Text>
          <Text 
            className="flex-1 text-base font-roobert-medium text-neutral-900 dark:text-neutral-50 ml-2"
            style={{ opacity: 0.6 }}
          >
            {toolText}
          </Text>
          <Animated.View style={chevronStyle}>
            <Icon
              as={ChevronDown}
              size={20}
              className="text-neutral-900 dark:text-neutral-50"
              strokeWidth={2}
            />
          </Animated.View>
        </Pressable>
      </Animated.View>

      {/* Expanded Actions List */}
      {isExpanded && (
        <View className="mt-2 gap-2">
          {tools.map((tool, idx) => (
            <CompletedActionItem
              key={tool.message_id || `tool-${idx}`}
              message={tool}
              onPress={() => onToolPress?.(tool)}
            />
          ))}
        </View>
      )}
    </View>
  );
});

// Legacy ToolCard kept for compatibility but simplified
const ToolCard = React.memo(function ToolCard({
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
  const completedData = useMemo(() => {
    if (!message || isLoading) return null;

    const parsed = parseToolMessage(message);
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

  const loadingData = useMemo(() => {
    if (!isLoading || !toolCall) return null;

    const toolName = toolCall.function_name || toolCall.name || 'Tool';
    const displayName = getUserFriendlyToolName(toolName);

    return { toolName, displayName };
  }, [isLoading, toolCall]);

  const displayName = isLoading ? loadingData?.displayName : completedData?.displayName;

  // Simplified: show just label with check or loader
  if (isLoading) {
    return (
      <View className="flex-row items-center gap-2 py-4">
        <Animated.View className="w-5 h-5 items-center justify-center">
          <Icon
            as={Loader2}
            size={20}
            className="text-neutral-500 dark:text-neutral-400 animate-spin"
            strokeWidth={2}
          />
        </Animated.View>
        <Text className="text-sm font-roobert text-neutral-500 dark:text-neutral-400">
          {displayName}
        </Text>
      </View>
    );
  }

  const isError = completedData?.isError;

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      className="flex-row items-center gap-2 py-2"
    >
      <View className="w-5 h-5 items-center justify-center">
        <Icon
          as={isError ? AlertCircle : Check}
          size={20}
          className={isError ? 'text-red-500' : 'text-neutral-500 dark:text-neutral-400'}
          strokeWidth={2}
        />
      </View>
      <Text className={`text-sm font-roobert ${isError ? 'text-red-500' : 'text-neutral-500 dark:text-neutral-400'}`}>
        {displayName}
      </Text>
    </Pressable>
  );
});

// Define streamable tools for mobile (matching frontend)
const MOBILE_STREAMABLE_TOOLS = {
  FILE_OPERATIONS: new Set([
    'Creating File', 'Rewriting File', 'AI File Edit', 'Editing Text', 'Editing File', 'Deleting File',
  ]),
  COMMAND_TOOLS: new Set([
    'Executing Command', 'Checking Command Output', 'Terminating Command', 'Listing Commands',
  ]),
  OTHER_STREAMABLE: new Set([
    'Creating Presentation', 'Creating Presentation Outline', 'Searching Web', 'Crawling Website',
  ]),
};

const isStreamableToolMobile = (toolName: string): boolean => {
  return Object.values(MOBILE_STREAMABLE_TOOLS).some(toolSet => toolSet.has(toolName));
};

const StreamingToolCallIndicator = React.memo(function StreamingToolCallIndicator({
  toolCall,
  toolName,
}: {
  toolCall: { function_name?: string; arguments?: Record<string, any> | string } | null;
  toolName: string;
  showExpanded?: boolean;
}) {
  // Use ToolCallItem component for consistency
  return (
    <ToolCallItem
      toolName={toolName}
      isComplete={false}
      isProcessing={true}
    />
  );
});

interface ThreadContentProps {
  messages: UnifiedMessage[];
  streamingTextContent?: string;
  streamingToolCall?: UnifiedMessage | null;
  agentStatus: 'idle' | 'running' | 'connecting' | 'error';
  handleToolClick?: (assistantMessageId: string | null, toolName: string, toolCallId?: string) => void;
  onFilePress?: (filePath: string) => void;
  onToolPress?: (toolMessages: ToolMessagePair[], initialIndex: number) => void;
  streamHookStatus?: string;
  sandboxId?: string;
  /** Sandbox URL for direct file access (used for presentations and HTML previews) */
  sandboxUrl?: string;
  agentName?: string;
  /** Handler to auto-fill chat input with a prompt (for follow-up prompts) */
  onPromptFill?: (prompt: string) => void;
}

interface MessageGroup {
  type: 'user' | 'assistant_group';
  messages: UnifiedMessage[];
  key: string;
}

export const ThreadContent: React.FC<ThreadContentProps> = React.memo(
  ({
    messages,
    streamingTextContent = '',
    streamingToolCall,
    agentStatus,
    handleToolClick,
    onFilePress,
    onToolPress,
    streamHookStatus = 'idle',
    sandboxId,
    sandboxUrl,
    agentName = 'Kortix',
    onPromptFill,
  }) => {
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';

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
      const groups: MessageGroup[] = [];
      let currentGroup: MessageGroup | null = null;
      let assistantGroupCounter = 0;

      displayMessages.forEach((message, index) => {
        const messageType = message.type;
        const key = message.message_id || `msg-${index}`;

        if (messageType === 'user') {
          if (currentGroup) {
            groups.push(currentGroup);
            currentGroup = null;
          }
          groups.push({ type: 'user', messages: [message], key });
        } else if (
          messageType === 'assistant' ||
          messageType === 'tool' ||
          messageType === 'browser_state'
        ) {
          const canAddToExistingGroup =
            currentGroup &&
            currentGroup.type === 'assistant_group' &&
            (() => {
              if (messageType === 'assistant') {
                const lastAssistantMsg = currentGroup.messages.findLast(
                  (m) => m.type === 'assistant'
                );
                if (!lastAssistantMsg) return true;

                const currentAgentId = message.agent_id;
                const lastAgentId = lastAssistantMsg.agent_id;
                return currentAgentId === lastAgentId;
              }
              return true;
            })();

          if (canAddToExistingGroup) {
            currentGroup?.messages.push(message);
          } else {
            if (currentGroup) {
              groups.push(currentGroup);
            }
            assistantGroupCounter++;
            currentGroup = {
              type: 'assistant_group',
              messages: [message],
              key: `assistant-group-${assistantGroupCounter}`,
            };
          }
        } else if (messageType !== 'status') {
          if (currentGroup) {
            groups.push(currentGroup);
            currentGroup = null;
          }
        }
      });

      if (currentGroup) {
        groups.push(currentGroup);
      }

      const mergedGroups: MessageGroup[] = [];
      let currentMergedGroup: MessageGroup | null = null;

      groups.forEach((group) => {
        if (group.type === 'assistant_group') {
          if (currentMergedGroup && currentMergedGroup.type === 'assistant_group') {
            currentMergedGroup.messages.push(...group.messages);
          } else {
            if (currentMergedGroup) {
              mergedGroups.push(currentMergedGroup);
            }
            currentMergedGroup = { ...group };
          }
        } else {
          if (currentMergedGroup) {
            mergedGroups.push(currentMergedGroup);
            currentMergedGroup = null;
          }
          mergedGroups.push(group);
        }
      });

      if (currentMergedGroup) {
        mergedGroups.push(currentMergedGroup);
      }

      const finalGroupedMessages = mergedGroups;

      if (streamingTextContent) {
        const lastGroup = finalGroupedMessages.at(-1);
        if (!lastGroup || lastGroup.type === 'user') {
          assistantGroupCounter++;
          finalGroupedMessages.push({
            type: 'assistant_group',
            messages: [
              {
                content: streamingTextContent,
                type: 'assistant',
                message_id: 'streamingTextContent',
                metadata: 'streamingTextContent',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                is_llm_message: true,
                thread_id: 'streamingTextContent',
                sequence: Infinity,
              },
            ],
            key: `assistant-group-${assistantGroupCounter}-streaming`,
          });
        } else if (lastGroup.type === 'assistant_group') {
          const lastMessage = lastGroup.messages[lastGroup.messages.length - 1];
          if (lastMessage.message_id !== 'streamingTextContent') {
            lastGroup.messages.push({
              content: streamingTextContent,
              type: 'assistant',
              message_id: 'streamingTextContent',
              metadata: 'streamingTextContent',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              is_llm_message: true,
              thread_id: 'streamingTextContent',
              sequence: Infinity,
            });
          }
        }
      }

      // Handle streaming tool call (e.g., ask/complete) - ensure there's a group to render in
      // This is needed because native tool calls have no text content, only metadata
      if (streamingToolCall && !streamingTextContent) {
        const lastGroup = finalGroupedMessages.at(-1);
        if (!lastGroup || lastGroup.type === 'user') {
          // Create new empty assistant group so streaming tool call can render
          assistantGroupCounter++;
          finalGroupedMessages.push({
            type: 'assistant_group',
            messages: [],
            key: `assistant-group-${assistantGroupCounter}-streaming-tool`,
          });
        }
      }

      return finalGroupedMessages;
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

    return (
      <View className="flex-1 pt-2" pointerEvents="box-none">
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

            const attachmentsMatch = messageContent.match(/\[Uploaded File: (.*?)\]/g);
            const attachments = attachmentsMatch
              ? attachmentsMatch
                .map((match: string) => {
                  const pathMatch = match.match(/\[Uploaded File: (.*?)\]/);
                  return pathMatch ? pathMatch[1] : null;
                })
                .filter(Boolean)
              : [];

            const cleanContent = messageContent.replace(/\[Uploaded File: .*?\]/g, '').trim();

            return (
              <View key={group.key} className="mt-8 mb-8">
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
                      className="max-w-[280px]"
                      style={{
                        borderRadius: 16,
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
                          borderTopLeftRadius={16}
                          borderTopRightRadius={16}
                          borderBottomLeftRadius={16}
                          borderBottomRightRadius={16}>
                          <View
                            className="px-4 py-3"
                            style={{
                              borderRadius: 16,
                              overflow: 'hidden',
                              backgroundColor: isDark ? 'rgba(64, 64, 64, 0.6)' : 'rgba(229, 229, 229, 0.6)',
                            }}>
                            <RNText
                              selectable
                              style={{
                                fontSize: 16,
                                lineHeight: 24,
                                fontFamily: 'Roobert-Regular',
                                color: isDark ? '#fafafa' : '#121215',
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
                          <View
                            className="px-4 py-3"
                            style={{
                              borderRadius: 16,
                              overflow: 'hidden',
                              backgroundColor: isDark ? 'rgba(64, 64, 64, 0.6)' : 'rgba(229, 229, 229, 0.6)',
                            }}>
                            <RNText
                              selectable
                              style={{
                                fontSize: 16,
                                lineHeight: 24,
                                fontFamily: 'Roobert-Regular',
                                color: isDark ? '#fafafa' : '#121215',
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
            const firstAssistantMsg = group.messages.find((m) => m.type === 'assistant');
            const groupAgentId = firstAssistantMsg?.agent_id;
            const assistantMessages = group.messages.filter((m) => m.type === 'assistant');
            const toolResultsMap = toolResultsMaps.get(group.key) || new Map();

            // Collect all tools from all messages in this group
            const allGroupTools: UnifiedMessage[] = [];
            assistantMessages.forEach((message) => {
              const linkedTools = toolResultsMap.get(message.message_id || null);
              if (linkedTools && linkedTools.length > 0) {
                allGroupTools.push(...linkedTools);
              }
            });

            // Render tool calls component to pass to renderAssistantMessage
            const toolCallsComponent = allGroupTools.length > 0 ? (
              <View key="action-tools">
                {allGroupTools.length >= 2 ? (
                  <CollapsibleToolActions
                    tools={allGroupTools}
                    onToolPress={handleToolPressInternal}
                  />
                ) : (
                  allGroupTools.map((toolMsg: UnifiedMessage, toolIdx: number) => (
                    <CompletedActionItem
                      key={`tool-${toolMsg.message_id || toolIdx}`}
                      message={toolMsg}
                      onPress={() => handleToolPressInternal(toolMsg)}
                    />
                  ))
                )}
              </View>
            ) : null;

            return (
              <View key={group.key}>
                {/* Agent response content with 16px gap between elements */}
                <View className="gap-4">
                  {assistantMessages.map((message, msgIndex) => {
                    const msgKey = message.message_id || `submsg-assistant-${msgIndex}`;

                    // Parse metadata to check for tool calls and text content
                    const metadata = safeJsonParse<ParsedMetadata>(message.metadata, {});
                    const toolCalls = metadata.tool_calls || [];
                    const textContent = metadata.text_content || '';

                    // Skip if no content (no text and no tool calls)
                    if (!textContent && toolCalls.length === 0) {
                      // Fallback: try parsing content for legacy messages
                      const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
                      if (!parsedContent.content) return null;
                    }

                    // Check if this is the latest message (last assistant message in the last group)
                    const isLastGroup = groupIndex === groupedMessages.length - 1;
                    const isLastAssistantMessage = msgIndex === assistantMessages.length - 1;
                    const isLatestMessage = isLastGroup && isLastAssistantMessage;

                    // Use metadata-based rendering (new approach)
                    // Pass tool calls only to the last message in the group
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
                      toolCallsToRender: isLastAssistantMessage ? toolCallsComponent : undefined,
                      toolMessages: isLastAssistantMessage ? allGroupTools : undefined, // Pass tool messages for inline attachments
                    });

                    return (
                      <View key={msgKey}>
                        {renderedContent && <View className="gap-2">{renderedContent}</View>}
                      </View>
                    );
                  })}
                </View>

                {/* Render streaming text content (XML tool calls or regular text) */}
                {groupIndex === groupedMessages.length - 1 &&
                    (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') &&
                    streamingTextContent && (
                      <View className="mt-2">
                        {(() => {
                          const rawContent = streamingTextContent || '';

                          let detectedTag: string | null = null;
                          let tagStartIndex = -1;

                          const functionCallsIndex = rawContent.indexOf('<function_calls>');
                          if (functionCallsIndex !== -1) {
                            detectedTag = 'function_calls';
                            tagStartIndex = functionCallsIndex;
                          } else {
                            for (const tag of HIDE_STREAMING_XML_TAGS) {
                              const openingTagPattern = `<${tag}`;
                              const index = rawContent.indexOf(openingTagPattern);
                              if (index !== -1) {
                                detectedTag = tag;
                                tagStartIndex = index;
                                break;
                              }
                            }
                          }

                          const textBeforeTag =
                            detectedTag && tagStartIndex >= 0
                              ? rawContent.substring(0, tagStartIndex)
                              : rawContent;
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
                  {groupIndex === groupedMessages.length - 1 &&
                    (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') &&
                    streamingToolCall &&
                    (() => {
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
                        }

                        // Extract text from arguments
                        const toolArgs: any = askOrCompleteTool.arguments;
                        let askCompleteText = '';
                        if (toolArgs) {
                          askCompleteText = extractTextFromArguments(toolArgs);
                        }

                        const toolName =
                          askOrCompleteTool.function_name?.replace(/_/g, '-').toLowerCase() || '';
                        const textToShow =
                          askCompleteText || (toolName === 'ask' ? 'Asking...' : 'Completing...');

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
                      // Render ALL tool calls, not just the first one
                      if (toolCalls.length > 0) {
                        // Check which tool calls have already been completed and rendered
                        const currentGroupToolMessages = group.messages.filter(
                          (m) => m.type === 'tool'
                        );

                        // Filter to only show tool calls that haven't been completed yet
                        const pendingToolCalls = toolCalls.filter((tc: any) => {
                          const toolCallId = tc.tool_call_id;
                          const matchingCompletedTool = currentGroupToolMessages.some(
                            (toolMsg: UnifiedMessage) => {
                              const toolMetadata = safeJsonParse<ParsedMetadata>(
                                toolMsg.metadata,
                                {}
                              );
                              return toolMetadata.tool_call_id === toolCallId;
                            }
                          );
                          return !matchingCompletedTool;
                        });

                        // Render all pending tool calls as vertical stacked cards
                        if (pendingToolCalls.length > 0) {
                          return (
                            <View className="flex-col gap-2">
                              {pendingToolCalls.map((tc: any, tcIndex: number) => {
                                const toolName = tc.function_name?.replace(/_/g, '-') || '';
                                return (
                                  <StreamingToolCallIndicator
                                    key={tc.tool_call_id || `streaming-tool-${tcIndex}`}
                                    toolCall={tc}
                                    toolName={toolName}
                                    showExpanded={false}
                                  />
                                );
                              })}
                            </View>
                          );
                        }

                        // If all tool calls have been completed, don't render anything
                        return null;
                      }

                      // Fallback if no tool calls found
                      return <StreamingToolCallIndicator toolCall={null} toolName="" />;
                    })()}

                  {/* Show loader when agent is running but not streaming, inside the last assistant group */}
                  {groupIndex === groupedMessages.length - 1 &&
                    (agentStatus === 'running' || agentStatus === 'connecting') &&
                    !streamingTextContent &&
                    !streamingToolCall &&
                    (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') &&
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
                      <View className="mt-2">
                        <AgentLoader />
                      </View>
                    )}
              </View>
            );
          }

          return null;
        })}

        {(agentStatus === 'running' || agentStatus === 'connecting') &&
          !streamingTextContent &&
          !streamingToolCall &&
          (messages.length === 0 || messages[messages.length - 1].type === 'user') && (
            <View className="mb-6">
              <AgentLoader />
            </View>
          )}

        <View className="h-2" />
      </View>
    );
  }
);

ThreadContent.displayName = 'ThreadContent';

export default ThreadContent;
