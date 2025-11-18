import React, { useMemo, useCallback } from 'react';
import { View, Pressable, Linking, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import type { UnifiedMessage, ParsedContent, ParsedMetadata } from '@/api/types';
import { safeJsonParse } from '@/lib/utils/message-grouping';
import {
  preprocessTextOnlyTools,
  parseXmlToolCalls,
  isNewXmlFormat,
  parseToolMessage,
  formatToolOutput,
  HIDE_STREAMING_XML_TAGS,
} from '@/lib/utils/tool-parser';
import { getToolIcon, getUserFriendlyToolName } from '@/lib/utils/tool-display';
import { useColorScheme } from 'nativewind';
import Markdown from 'react-native-markdown-display';
import { markdownStyles, markdownStylesDark } from '@/lib/utils/markdown-styles';
import { AgentIdentifier } from '@/components/agents';
import {
  FileAttachmentsGrid,
  extractFileReferences,
  removeFileReferences
} from './FileAttachmentRenderer';
import { AgentLoader } from './AgentLoader';
import { CircleDashed, CheckCircle2, AlertCircle, Info } from 'lucide-react-native';
import { StreamingToolCard } from './StreamingToolCard';
import { TaskCompletedFeedback } from './tool-views/complete-tool/TaskCompletedFeedback';

export interface ToolMessagePair {
  assistantMessage: UnifiedMessage | null;
  toolMessage: UnifiedMessage;
}

function renderStandaloneAttachments(
  attachments: string[],
  sandboxId?: string,
  onFilePress?: (filePath: string) => void,
  alignRight: boolean = false
) {
  if (!attachments || attachments.length === 0) return null;

  const validAttachments = attachments.filter(attachment => attachment && attachment.trim() !== '');
  if (validAttachments.length === 0) return null;

  return (
    <View className={`w-full my-4 ${alignRight ? 'items-end' : 'items-start'}`}>
      <FileAttachmentsGrid
        filePaths={validAttachments}
        sandboxId={sandboxId}
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

  content = content.replace(/<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi, (match) => {
    if (match.includes('<parameter name="attachments"')) return match;
    return match.replace(/<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi, '$1');
  });

  content = content.replace(/<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi, (match) => {
    if (match.includes('<parameter name="attachments"')) return match;
    return match.replace(/<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi, '$1');
  });


  content = content.replace(/<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)$/gi, (match) => {
    if (match.includes('<parameter name="attachments"')) return match;
    return match.replace(/<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)$/gi, '$1');
  });

  content = content.replace(/<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)$/gi, (match) => {
    if (match.includes('<parameter name="attachments"')) return match;
    return match.replace(/<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)$/gi, '$1');
  });

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
  onFilePress?: (filePath: string) => void;
  sandboxId?: string;
  isLatestMessage?: boolean;
}

function MarkdownContent({ content, handleToolClick, messageId, onFilePress, sandboxId, isLatestMessage }: MarkdownContentProps) {
  const { colorScheme } = useColorScheme();

  const processedContent = useMemo(() => {
    let processed = preprocessTextOnlyToolsLocal(content);

    processed = processed.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');

    const oldFormatToolTags = [
      'execute-command', 'check-command-output', 'terminate-command',
      'create-file', 'delete-file', 'str-replace', 'edit-file', 'full-file-rewrite',
      'read-file', 'create-tasks', 'update-tasks',
      'browser-navigate-to', 'browser-act', 'browser-extract-content', 'browser-screenshot',
      'browser-click-element', 'browser-close-tab', 'browser-input-text',
      'web-search', 'crawl-webpage', 'scrape-webpage',
      'expose-port', 'call-data-provider', 'get-data-provider-endpoints',
      'create-sheet', 'update-sheet', 'view-sheet',
      'execute-code', 'make-phone-call', 'end-call',
      'designer-create-or-edit', 'image-edit-or-generate',
    ];

    for (const tag of oldFormatToolTags) {
      const regex = new RegExp(`<${tag}[^>]*>.*?<\\/${tag}>|<${tag}[^>]*\\/>`, 'gis');
      processed = processed.replace(regex, '');
    }

    processed = processed.replace(/^\s*\n/gm, '');
    processed = processed.trim();

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
              <Markdown
                style={colorScheme === 'dark' ? markdownStylesDark : markdownStyles}
                onLinkPress={(url) => {
                  Linking.openURL(url).catch(console.error);
                  return false;
                }}
              >
                {textBeforeBlock}
              </Markdown>
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

          const attachmentArray = Array.isArray(attachments) ? attachments :
            (typeof attachments === 'string' ? attachments.split(',').map(a => a.trim()) : []);

          contentParts.push(
            <View key={`ask-${match?.index}-${index}`} className="space-y-3">
              <Markdown
                style={colorScheme === 'dark' ? markdownStylesDark : markdownStyles}
                onLinkPress={(url) => {
                  Linking.openURL(url).catch(console.error);
                  return false;
                }}
              >
                {askText}
              </Markdown>
              
              <View className="flex-row items-start gap-2.5 rounded-xl border border-border bg-muted/40 dark:bg-muted/20 px-3 py-2.5 mt-2">
                <Icon as={Info} size={16} className="text-muted-foreground mt-0.5 flex-shrink-0" />
                <Text className="text-sm font-roobert text-muted-foreground flex-1 leading-relaxed">
                  Kortix will automatically continue working once you provide your response.
                </Text>
              </View>
            </View>
          );

          const standaloneAttachments = renderStandaloneAttachments(attachmentArray, sandboxId, onFilePress);
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

          const attachmentArray = Array.isArray(attachments) ? attachments :
            (typeof attachments === 'string' ? attachments.split(',').map(a => a.trim()) : []);
          contentParts.push(
            <View key={`complete-${match?.index}-${index}`} className="space-y-3">
              <Markdown
                style={colorScheme === 'dark' ? markdownStylesDark : markdownStyles}
                onLinkPress={(url) => {
                  Linking.openURL(url).catch(console.error);
                  return false;
                }}
              >
                {completeText}
              </Markdown>
              
              <TaskCompletedFeedback
                taskSummary={completeText}
                threadId={message.thread_id}
                messageId={messageId}
                onFollowUpClick={(prompt) => {
                  // TODO: Handle follow-up click - could trigger a new message
                  console.log('Follow-up clicked:', prompt);
                }}
              />
            </View>
          );

          const standaloneAttachments = renderStandaloneAttachments(attachmentArray, sandboxId, onFilePress);
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
            <Markdown
              style={colorScheme === 'dark' ? markdownStylesDark : markdownStyles}
              onLinkPress={(url) => {
                Linking.openURL(url).catch(console.error);
                return false;
              }}
            >
              {remainingText}
            </Markdown>
          </View>
        );
      }
    }

    return <View>{contentParts.length > 0 ? contentParts : (
      <Markdown
        style={colorScheme === 'dark' ? markdownStylesDark : markdownStyles}
        onLinkPress={(url) => {
          Linking.openURL(url).catch(console.error);
          return false;
        }}
      >
        {processedContent}
      </Markdown>
    )}</View>;
  }

  return (
    <Markdown
      style={colorScheme === 'dark' ? markdownStylesDark : markdownStyles}
      onLinkPress={(url) => {
        Linking.openURL(url).catch(console.error);
        return false;
      }}
    >
      {processedContent}
    </Markdown>
  );
}

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
        className="flex-row items-center gap-3 p-3 rounded-3xl border border-neutral-400/50 dark:border-neutral-700 bg-neutral-200 dark:bg-neutral-800 active:opacity-70"
      >
        <View className="h-8 w-8 rounded-xl border border-neutral-400/50 dark:border-neutral-700 items-center justify-center bg-primary/10">
          <Icon as={CircleDashed} size={16} className="text-primary animate-spin" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-roobert-medium text-foreground mb-0.5">
            {displayName}
          </Text>
          <Text className="text-xs text-muted-foreground">
            Executing...
          </Text>
        </View>
      </Pressable>
    );
  }

  const isError = completedData?.isError;

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      className="flex-row items-center gap-3 p-3 rounded-3xl bg-primary/10 active:opacity-70"
    >
      <View className={`h-8 w-8 rounded-xl items-center justify-center ${isError ? 'bg-destructive/10' : 'bg-primary/10'}`}>
        <Icon
          as={isError ? AlertCircle : IconComponent}
          size={16}
          className={isError ? 'text-destructive' : 'text-primary'}
        />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-roobert-medium text-foreground mb-0.5">
          {displayName}
        </Text>
      </View>
      <Icon
        as={isError ? AlertCircle : CheckCircle2}
        size={16}
        className={isError ? 'text-destructive' : 'text-primary'}
      />
    </Pressable>
  );
});

interface ThreadContentProps {
  messages: UnifiedMessage[];
  streamingTextContent?: string;
  streamingToolCall?: any;
  agentStatus: 'idle' | 'running' | 'connecting' | 'error';
  handleToolClick?: (assistantMessageId: string | null, toolName: string) => void;
  onFilePress?: (filePath: string) => void;
  onToolPress?: (toolMessages: ToolMessagePair[], initialIndex: number) => void;
  streamHookStatus?: string;
  sandboxId?: string;
  agentName?: string;
}

interface MessageGroup {
  type: 'user' | 'assistant_group';
  messages: UnifiedMessage[];
  key: string;
}

export const ThreadContent: React.FC<ThreadContentProps> = ({
  messages,
  streamingTextContent = "",
  streamingToolCall,
  agentStatus,
  handleToolClick,
  onFilePress,
  onToolPress,
  streamHookStatus = "idle",
  sandboxId,
  agentName = 'Suna',
}) => {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const displayMessages = useMemo(() => {
    const displayableTypes = ['user', 'assistant', 'tool', 'system', 'status', 'browser_state'];
    return messages.filter(msg => displayableTypes.includes(msg.type));
  }, [messages]);

  const allToolMessages = useMemo(() => {
    const pairs: ToolMessagePair[] = [];
    const assistantMessages = messages.filter(m => m.type === 'assistant');
    const toolMessages = messages.filter(m => m.type === 'tool');

    const toolMap = new Map<string | null, UnifiedMessage[]>();
    toolMessages.forEach(toolMsg => {
      const metadata = safeJsonParse<ParsedMetadata>(toolMsg.metadata, {});
      const assistantId = metadata.assistant_message_id || null;

      const parsed = parseToolMessage(toolMsg.content);
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
      } else if (messageType === 'assistant' || messageType === 'tool' || messageType === 'browser_state') {
        const canAddToExistingGroup = currentGroup &&
          currentGroup.type === 'assistant_group' &&
          (() => {
            if (messageType === 'assistant') {
              const lastAssistantMsg = currentGroup.messages.findLast(m => m.type === 'assistant');
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
            key: `assistant-group-${assistantGroupCounter}`
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
          messages: [{
            content: streamingTextContent,
            type: 'assistant',
            message_id: 'streamingTextContent',
            metadata: 'streamingTextContent',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            is_llm_message: true,
            thread_id: 'streamingTextContent',
            sequence: Infinity,
          }],
          key: `assistant-group-${assistantGroupCounter}-streaming`
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

    return finalGroupedMessages;
  }, [displayMessages, streamingTextContent]);

  if (displayMessages.length === 0 && !streamingTextContent && !streamingToolCall && agentStatus === 'idle') {
    return (
      <View className="flex-1 min-h-[60vh] items-center justify-center">
        <Text className="text-center text-muted-foreground">
          Send a message to start.
        </Text>
      </View>
    );
  }

  const toolResultsMaps = useMemo(() => {
    const maps = new Map<string, Map<string | null, UnifiedMessage[]>>();

    groupedMessages.forEach((group) => {
      if (group.type === 'assistant_group') {
        const toolMessages = group.messages.filter(m => m.type === 'tool');
        const map = new Map<string | null, UnifiedMessage[]>();

        toolMessages.forEach(toolMsg => {
          const metadata = safeJsonParse<ParsedMetadata>(toolMsg.metadata, {});
          const assistantId = metadata.assistant_message_id || null;

          const parsed = parseToolMessage(toolMsg.content);
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

  const handleToolPress = useCallback((clickedToolMsg: UnifiedMessage) => {
    const clickedIndex = allToolMessages.findIndex(
      t => t.toolMessage.message_id === clickedToolMsg.message_id
    );
    console.log('🎯 [ThreadContent] Tool clicked:', {
      toolId: clickedToolMsg.message_id,
      indexInThread: clickedIndex,
      totalToolsInThread: allToolMessages.length,
    });
    onToolPress?.(allToolMessages, clickedIndex >= 0 ? clickedIndex : 0);
  }, [allToolMessages, onToolPress]);

  return (
    <View className="flex-1 pt-4">
      {groupedMessages.map((group, groupIndex) => {
        if (group.type === 'user') {
          const message = group.messages[0];
          const messageContent = (() => {
            try {
              const parsed = safeJsonParse<ParsedContent>(message.content, { content: message.content });
              const content = parsed.content || message.content;

              if (Array.isArray(content)) {
                return content
                  .filter((item: any) => item.type === 'text' || typeof item === 'string')
                  .map((item: any) => typeof item === 'string' ? item : item.text || '')
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
                  .map((item: any) => typeof item === 'string' ? item : item.text || '')
                  .join('\n');
              }
              return JSON.stringify(message.content || '');
            }
          })();

          const attachmentsMatch = messageContent.match(/\[Uploaded File: (.*?)\]/g);
          const attachments = attachmentsMatch
            ? attachmentsMatch.map((match: string) => {
              const pathMatch = match.match(/\[Uploaded File: (.*?)\]/);
              return pathMatch ? pathMatch[1] : null;
            }).filter(Boolean)
            : [];

          const cleanContent = messageContent.replace(/\[Uploaded File: .*?\]/g, '').trim();

          return (
            <View key={group.key} className="mb-6">
              {renderStandaloneAttachments(attachments as string[], sandboxId, onFilePress, true)}

              {cleanContent && (
                <View className="flex-row justify-end">
                  <View
                    className="max-w-[85%] bg-card border border-border px-4 py-0.5"
                    style={{
                      borderRadius: 24,
                      borderBottomRightRadius: 8,
                    }}
                  >
                    <Markdown
                      style={colorScheme === 'dark' ? markdownStylesDark : markdownStyles}
                      onLinkPress={(url) => {
                        Linking.openURL(url).catch(console.error);
                        return false;
                      }}
                    >
                      {cleanContent}
                    </Markdown>
                  </View>
                </View>
              )}
            </View>
          );
        }

        if (group.type === 'assistant_group') {
          const firstAssistantMsg = group.messages.find(m => m.type === 'assistant');
          const groupAgentId = firstAssistantMsg?.agent_id;
          const assistantMessages = group.messages.filter(m => m.type === 'assistant');
          const toolResultsMap = toolResultsMaps.get(group.key) || new Map();

          return (
            <View key={group.key} className="mb-6">
              <View className="flex-row items-center mb-3">
                <AgentIdentifier
                  agentId={groupAgentId}
                  size={24}
                  showName
                />
              </View>

              <View className="gap-3">
                {assistantMessages.map((message, msgIndex) => {
                  const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
                  const msgKey = message.message_id || `submsg-assistant-${msgIndex}`;

                  if (!parsedContent.content) return null;

                  const linkedTools = toolResultsMap.get(message.message_id || null);

                  // Check if this is the latest message (last assistant message in the last group)
                  const isLastGroup = groupIndex === groupedMessages.length - 1;
                  const isLastAssistantMessage = msgIndex === assistantMessages.length - 1;
                  const isLatestMessage = isLastGroup && isLastAssistantMessage;

                  return (
                    <View key={msgKey}>
                      <MarkdownContent
                        content={parsedContent.content}
                        handleToolClick={handleToolClick}
                        messageId={message.message_id}
                        onFilePress={onFilePress}
                        sandboxId={sandboxId}
                        isLatestMessage={isLatestMessage}
                      />

                      {linkedTools && linkedTools.length > 0 && (
                        <View className="gap-2 mt-3">
                          {linkedTools.map((toolMsg: UnifiedMessage, toolIdx: number) => {
                            const handlePress = () => {
                              const clickedIndex = allToolMessages.findIndex(
                                t => t.toolMessage.message_id === toolMsg.message_id
                              );
                              onToolPress?.(allToolMessages, clickedIndex >= 0 ? clickedIndex : 0);
                            };

                            return (
                              <ToolCard
                                key={`tool-${toolMsg.message_id || toolIdx}`}
                                message={toolMsg}
                                onPress={handlePress}
                              />
                            );
                          })}
                        </View>
                      )}
                    </View>
                  );
                })}

                {groupIndex === groupedMessages.length - 1 && (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') && (
                  <View className="mt-3">
                    {(() => {
                      const rawContent = streamingTextContent || '';

                      if (!rawContent) {
                        return <AgentLoader />;
                      }

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

                      const textBeforeTag = detectedTag && tagStartIndex >= 0 ? rawContent.substring(0, tagStartIndex) : rawContent;
                      const processedTextBeforeTag = preprocessTextOnlyToolsLocal(textBeforeTag);

                      return (
                        <View className="gap-3">
                          {processedTextBeforeTag.trim() && (
                            <Markdown
                              style={colorScheme === 'dark' ? markdownStylesDark : markdownStyles}
                              onLinkPress={(url) => {
                                Linking.openURL(url).catch(console.error);
                                return false;
                              }}
                            >
                              {processedTextBeforeTag}
                            </Markdown>
                          )}
                          {detectedTag && (
                            <StreamingToolCard content={rawContent.substring(tagStartIndex)} />
                          )}
                        </View>
                      );
                    })()}
                  </View>
                )}

              </View>
            </View>
          );
        }

        return null;
      })}

      {((agentStatus === 'running' || agentStatus === 'connecting') && !streamingTextContent && !streamingToolCall &&
        (messages.length === 0 || messages[messages.length - 1].type === 'user')) && (
          <View className="mb-6">
            <View className="flex-row items-center mb-3">
              <AgentIdentifier
                size={24}
                showName
              />
            </View>
            <AgentLoader />
          </View>
        )}

      <View className="h-4" />
    </View>
  );
};

export default ThreadContent;

