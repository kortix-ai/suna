import React, { useMemo, useCallback } from 'react';
import { View, Pressable, Linking, Text as RNText, TextInput, Platform } from 'react-native';
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
import { getToolIcon, getUserFriendlyToolName } from '@/lib/utils/tool-display';
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
import { CircleDashed, CheckCircle2, AlertCircle, Info } from 'lucide-react-native';
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
    <View className={`my-4 w-full ${alignRight ? 'items-end' : 'items-start'}`}>
      <FileAttachmentsGrid
        filePaths={validAttachments}
        sandboxId={sandboxId}
        sandboxUrl={sandboxUrl}
        compact={false}
        showPreviews={true}
        onFilePress={onFilePress}
      />
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
  handleToolClick?: (assistantMessageId: string | null, toolName: string) => void;
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
  const { colorScheme } = useColorScheme();

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

  const toolName = isLoading ? loadingData?.toolName : completedData?.toolName;
  const displayName = isLoading ? loadingData?.displayName : completedData?.displayName;
  const IconComponent = toolName ? getToolIcon(toolName) : CircleDashed;

  if (isLoading) {
    return (
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        className="flex-row items-center gap-3 rounded-3xl border border-border bg-card p-3">
        <View className="h-8 w-8 items-center justify-center rounded-xl border border-border bg-background">
          <Icon as={CircleDashed} size={16} className="animate-spin text-primary" />
        </View>
        <View className="flex-1">
          <Text className="mb-0.5 font-roobert-medium text-sm text-foreground">{displayName}</Text>
          <Text className="text-xs text-muted-foreground">Executing...</Text>
        </View>
      </Pressable>
    );
  }

  const isError = completedData?.isError;

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      className="flex-row items-center gap-3 rounded-3xl border border-border bg-card p-3">
      <View
        className={`h-8 w-8 items-center justify-center rounded-xl border border-border ${isError ? 'bg-destructive/10' : 'bg-background'}`}>
        <Icon
          as={isError ? AlertCircle : IconComponent}
          size={16}
          className={isError ? 'text-destructive' : 'text-primary'}
        />
      </View>
      <View className="flex-1">
        <Text className="mb-0.5 font-roobert-medium text-sm text-foreground">{displayName}</Text>
      </View>
      <Icon
        as={isError ? AlertCircle : CheckCircle2}
        size={16}
        className={isError ? 'text-destructive' : 'text-primary'}
      />
    </Pressable>
  );
});

const StreamingToolCallIndicator = React.memo(function StreamingToolCallIndicator({
  toolCall,
  toolName,
}: {
  toolCall: { function_name?: string; arguments?: Record<string, any> | string } | null;
  toolName: string;
}) {
  // Extract display parameter using the exact same logic as getToolCallDisplayParam
  const paramDisplay = useMemo(() => {
    if (!toolCall?.arguments) return '';
    let args: Record<string, any> = {};
    if (typeof toolCall.arguments === 'string') {
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        args = {};
      }
    } else {
      args = toolCall.arguments;
    }
    return args.file_path || args.path || args.command || args.query || args.url || '';
  }, [toolCall]);

  const displayName = toolName ? getUserFriendlyToolName(toolName) : 'Using Tool';
  const IconComponent = toolName ? getToolIcon(toolName) : CircleDashed;

  // Use the exact same style as ToolCard when isLoading=true
  return (
    <Pressable
      disabled
      className="flex-row items-center gap-3 rounded-3xl border border-border bg-card p-3">
      <View className="h-8 w-8 items-center justify-center rounded-xl border border-border bg-background">
        <Icon as={CircleDashed} size={16} className="animate-spin text-primary" />
      </View>
      <View className="flex-1">
        <Text className="mb-0.5 font-roobert-medium text-sm text-foreground">{displayName}</Text>
        {paramDisplay && (
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {paramDisplay}
          </Text>
        )}
      </View>
    </Pressable>
  );
});

interface ThreadContentProps {
  messages: UnifiedMessage[];
  streamingTextContent?: string;
  streamingToolCall?: UnifiedMessage | null;
  agentStatus: 'idle' | 'running' | 'connecting' | 'error';
  handleToolClick?: (assistantMessageId: string | null, toolName: string) => void;
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
      <View className="flex-1 pt-4">
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
              <View key={group.key} className="mb-6">
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
                      className="max-w-[85%] border border-border"
                      style={{
                        borderRadius: 24,
                        borderBottomRightRadius: 8,
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
                          <View
                            className="bg-card px-4 py-3"
                            style={{
                              borderRadius: 24,
                              borderBottomRightRadius: 8,
                              overflow: 'hidden',
                            }}>
                            <RNText
                              selectable
                              style={{
                                fontSize: 16,
                                lineHeight: 24,
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
                          <View
                            className="bg-card px-4 py-3"
                            style={{
                              borderRadius: 24,
                              borderBottomRightRadius: 8,
                              overflow: 'hidden',
                            }}>
                            <RNText
                              selectable
                              style={{
                                fontSize: 16,
                                lineHeight: 24,
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
            const firstAssistantMsg = group.messages.find((m) => m.type === 'assistant');
            const groupAgentId = firstAssistantMsg?.agent_id;
            const assistantMessages = group.messages.filter((m) => m.type === 'assistant');
            const toolResultsMap = toolResultsMaps.get(group.key) || new Map();

            return (
              <View key={group.key} className="mb-6">
                <View className="mb-3 flex-row items-center">
                  <AgentIdentifier agentId={groupAgentId} size={24} showName />
                </View>

                <View className="gap-3">
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

                    const linkedTools = toolResultsMap.get(message.message_id || null);

                    // Check if this is the latest message (last assistant message in the last group)
                    const isLastGroup = groupIndex === groupedMessages.length - 1;
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
                          <View className="mt-2 gap-1">
                            {linkedTools.map((toolMsg: UnifiedMessage, toolIdx: number) => (
                              <ToolCard
                                key={`tool-${toolMsg.message_id || toolIdx}`}
                                message={toolMsg}
                                onPress={() => handleToolPressInternal(toolMsg)}
                              />
                            ))}
                          </View>
                        )}
                      </View>
                    );
                  })}

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

                      // For other tools, render tool call indicator with spinning icon
                      // Only hide if we can confirm the completed tool call is already rendered
                      if (toolCalls.length > 0) {
                        const firstToolCall = toolCalls[0];
                        const toolName = firstToolCall.function_name?.replace(/_/g, '-') || '';
                        const toolCallId = firstToolCall.tool_call_id;

                        // Check if this tool call has already been completed and rendered
                        // Look for a tool message in the current group with matching tool_call_id
                        const currentGroupToolMessages = group.messages.filter(
                          (m) => m.type === 'tool'
                        );

                        // Check if any tool message in this group matches the streaming tool call
                        const matchingCompletedTool = currentGroupToolMessages.some(
                          (toolMsg: UnifiedMessage) => {
                            const toolMetadata = safeJsonParse<ParsedMetadata>(
                              toolMsg.metadata,
                              {}
                            );
                            return toolMetadata.tool_call_id === toolCallId;
                          }
                        );

                        // Only show streaming indicator if no matching completed tool is found
                        if (!matchingCompletedTool) {
                          return (
                            <StreamingToolCallIndicator
                              toolCall={firstToolCall}
                              toolName={toolName}
                            />
                          );
                        }

                        // If matching completed tool exists, don't render streaming indicator
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
                    (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') && (
                      <View className="mt-2">
                        <AgentLoader />
                      </View>
                    )}
                </View>
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
              <View className="mb-3 flex-row items-center">
                <AgentIdentifier size={24} showName />
              </View>
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
