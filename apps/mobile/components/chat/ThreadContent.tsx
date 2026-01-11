import React, { useMemo, useCallback } from 'react';
import { View, Pressable, Linking, Text as RNText, TextInput, Platform, ScrollView, Image } from 'react-native';
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
import { Icon } from '@/components/ui/icon';
import type { UnifiedMessage, ParsedContent, ParsedMetadata } from '@agentpress/shared';
import {
  safeJsonParse,
  getUserFriendlyToolName,
  extractTextFromPartialJson,
  extractTextFromArguments,
  isAskOrCompleteTool,
  findAskOrCompleteTool,
  shouldSkipStreamingRender,
} from '@agentpress/shared';
import {
  parseXmlToolCalls,
  isNewXmlFormat,
  parseToolMessage,
  formatToolOutput,
  isHiddenTool,
} from '@agentpress/shared/tools';
import { HIDE_STREAMING_XML_TAGS } from '@agentpress/shared/tools';
import { groupMessagesWithStreaming } from '@agentpress/shared/utils';
import { preprocessTextOnlyTools } from '@agentpress/shared/tools';
import { getToolIcon } from '@/lib/icons/tool-icons';
import { useColorScheme } from 'nativewind';
import { useAgent } from '@/contexts/AgentContext';
import { SelectableMarkdownText } from '@/components/ui/selectable-markdown';
import { autoLinkUrls } from '@agentpress/shared';
import { FileAttachmentsGrid } from './FileAttachmentRenderer';
import { CheckCircle2, AlertCircle, Info, CircleDashed } from 'lucide-react-native';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { AgentLoader } from './AgentLoader';
import { StreamingToolCard } from './StreamingToolCard';
import { CompactToolCard, CompactStreamingToolCard } from './CompactToolCard';
import { MediaGenerationInline } from './MediaGenerationInline';
import { TaskCompletedFeedback } from './tool-views/complete-tool/TaskCompletedFeedback';
import { renderAssistantMessage } from './assistant-message-renderer';
import { PromptExamples } from '@/components/shared';
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
          <KortixLoader size="small" />
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
  showExpanded = false,
  onPress,
}: {
  toolCall: { function_name?: string; arguments?: Record<string, any> | string; completed?: boolean; tool_result?: any; tool_call_id?: string } | null;
  toolName: string;
  showExpanded?: boolean;
  onPress?: () => void;
}) {
  const scrollViewRef = React.useRef<any>(null);
  
  // Check if tool is completed (has tool_result or completed flag)
  // tool_result can be an object with success/output/error, or just a truthy value
  const isCompleted = toolCall?.completed === true || 
                     (toolCall?.tool_result !== undefined && 
                      toolCall?.tool_result !== null &&
                      (typeof toolCall.tool_result === 'object' || Boolean(toolCall.tool_result)));
  
  // Extract display parameter and streaming content
  const { paramDisplay, streamingContent } = useMemo(() => {
    if (!toolCall?.arguments) return { paramDisplay: '', streamingContent: '' };
    let args: Record<string, any> = {};
    if (typeof toolCall.arguments === 'string') {
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        // For partial JSON, just use the raw string as content
        return { 
          paramDisplay: '', 
          streamingContent: toolCall.arguments 
        };
      }
    } else {
      args = toolCall.arguments;
    }
    
    const param = args.file_path || args.path || args.command || args.query || args.url || args.slide_number?.toString() || '';
    
    // Extract streamable content based on tool type
    let content = '';
    const displayName = getUserFriendlyToolName(toolName);
    
    if (MOBILE_STREAMABLE_TOOLS.FILE_OPERATIONS.has(displayName)) {
      content = args.file_contents || args.code_edit || args.content || '';
    } else if (MOBILE_STREAMABLE_TOOLS.COMMAND_TOOLS.has(displayName)) {
      content = args.command || '';
    } else if (displayName === 'Creating Presentation' || displayName === 'Creating Presentation Outline') {
      // For presentations, show slide content
      content = args.content || args.title || args.slide_content || JSON.stringify(args, null, 2);
    } else {
      // For other tools, show JSON representation
      content = Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : '';
    }
    
    return { paramDisplay: param, streamingContent: content };
  }, [toolCall, toolName]);

  const displayName = toolName ? getUserFriendlyToolName(toolName) : 'Using Tool';
  const IconComponent = toolName ? getToolIcon(toolName) : CircleDashed;
  const shouldShowContent = showExpanded && isStreamableToolMobile(displayName) && streamingContent.length > 0;

  // Auto-scroll to bottom when content changes
  React.useEffect(() => {
    if (scrollViewRef.current && shouldShowContent) {
      scrollViewRef.current.scrollToEnd?.({ animated: false });
    }
  }, [streamingContent, shouldShowContent]);

  // Expanded card with streaming content
  if (shouldShowContent) {
    const cardContent = (
      <View className="rounded-3xl border border-border bg-card overflow-hidden">
        {/* Header */}
        <View className="flex-row items-center gap-3 p-3 border-b border-border">
          <View className="h-8 w-8 items-center justify-center rounded-xl border border-border bg-background">
            <Icon as={IconComponent} size={16} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="mb-0.5 font-roobert-medium text-sm text-foreground">{displayName}</Text>
            {paramDisplay && (
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {paramDisplay}
              </Text>
            )}
          </View>
          {isCompleted ? (
            <Icon as={CheckCircle2} size={16} className="text-emerald-500" />
          ) : (
            <KortixLoader size="small" />
          )}
        </View>
        
        {/* Streaming content */}
        <ScrollView
          ref={scrollViewRef}
          style={{ maxHeight: 200 }}
          showsVerticalScrollIndicator={true}
        >
          <View className="p-3">
            <Text
              className="text-xs text-foreground font-roobert-mono"
              style={{ fontFamily: 'monospace' }}
            >
              {streamingContent}
            </Text>
          </View>
        </ScrollView>
      </View>
    );

    // Make clickable when completed
    if (isCompleted && onPress) {
      return (
        <Pressable onPress={onPress} className="active:opacity-80">
          {cardContent}
        </Pressable>
      );
    }

    return cardContent;
  }

  // Simple indicator - matches finished ToolCard style exactly
  const indicatorContent = (
    <View className="flex-row items-center gap-3 rounded-3xl border border-border bg-card p-3">
      <View className="h-8 w-8 items-center justify-center rounded-xl border border-border bg-background">
        <Icon as={IconComponent} size={16} className="text-primary" />
      </View>
      <View className="flex-1">
        <Text className="mb-0.5 font-roobert-medium text-sm text-foreground">{displayName}</Text>
        {paramDisplay && (
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {paramDisplay}
          </Text>
        )}
      </View>
      {isCompleted ? (
        <Icon as={CheckCircle2} size={16} className="text-emerald-500" />
      ) : (
        <KortixLoader size="small" />
      )}
    </View>
  );

  // Make clickable when completed
  if (isCompleted && onPress) {
    return (
      <Pressable onPress={onPress} className="active:opacity-80">
        {indicatorContent}
      </Pressable>
    );
  }

  return indicatorContent;
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
  sandboxUrl?: string;
  agentName?: string;
  onPromptFill?: (prompt: string) => void;
  isSendingMessage?: boolean;
  onRequestScroll?: () => void;
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
    isSendingMessage = false,
    onRequestScroll,
  }) => {
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const { agents } = useAgent();

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
            let pendingAttachments: Array<{ uri: string; name: string; type: string; size?: number }> = [];
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
                    {pendingAttachments.map((attachment, idx) => (
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
                            {/* Uploading overlay */}
                            <View 
                              className="absolute inset-0 bg-black/40 items-center justify-center"
                              style={{ borderRadius: 16 }}
                            >
                              <View className="bg-white/20 rounded-full p-2">
                                <KortixLoader size="small" />
                              </View>
                            </View>
                          </>
                        ) : (
                          <View className="flex-1 items-center justify-center bg-card">
                            <KortixLoader size="small" />
                            <Text className="text-xs text-muted-foreground text-center px-2 mt-2" numberOfLines={2}>
                              {attachment.name}
                            </Text>
                          </View>
                        )}
                      </View>
                    ))}
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

            return (
              <View key={group.key} className="mb-6">
                <View className="mb-3 flex-row items-center">
                  {renderAgentIndicator(groupAgentId)}
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
                                      arguments: parsed?.call?.arguments || {},
                                      tool_call_id: parsed?.call?.tool_call_id,
                                    }}
                                    toolResult={parsed?.result ? {
                                      output: parsed.result.output,
                                      success: parsed.result.success,
                                    } : undefined}
                                    onToolClick={() => handleToolPressInternal(toolMsg)}
                                    sandboxId={sandboxId}
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
                    (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') &&
                    streamingToolCall &&
                    messages[messages.length - 1]?.type !== 'user' &&
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
                      
                      // Filter out hidden tools (internal/initialization tools)
                      const visibleToolCalls = toolCalls.filter((tc: any) => {
                        const toolName = tc.function_name?.replace(/_/g, '-') || '';
                        return !isHiddenTool(toolName);
                      });

                      // If all tools were hidden, don't render anything
                      if (visibleToolCalls.length === 0 && toolCalls.length > 0) {
                        return null;
                      }

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
                                    sandboxId={sandboxId}
                                  />
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
                        <AgentLoader />
                      </View>
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
          const hasStreamingContent = Boolean(streamingTextContent || streamingToolCall);
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
            
            // Has visible text before tag?
            const textBeforeTag = detectedTag && tagStartIndex >= 0
              ? displayContent.substring(0, Math.min(displayContent.length, tagStartIndex))
              : displayContent;
            const hasText = preprocessTextOnlyToolsLocal(textBeforeTag).trim().length > 0;
            
            // Has visible tag (tool card)?
            const hasTag = detectedTag !== null;
            
            return hasText || hasTag;
          })();
          
          // Brewing = agent is active but no VISIBLE content yet
          // Keep showing AgentLoader until we have actual visible streaming content
          const isBrewing = isAgentActive && !hasVisibleStreamingText && !streamingToolCall;
          
          return (
            <View className="mb-6">
              <View className="mb-3 flex-row items-center">
                {renderAgentIndicator(null)}
              </View>
              
              {/* Contemplating state */}
              {isContemplating && (
                <View className="h-6 justify-center">
                  <View className="flex-row items-center">
                    <Text className="text-xs text-muted-foreground italic">Contemplating response...</Text>
                  </View>
                </View>
              )}
              
              {/* Brewing ideas state - show until we have VISIBLE streaming content */}
              {isBrewing && (
                <View className="mt-4">
                  <AgentLoader />
                </View>
              )}
              
              {/* Streaming text content - only show when we have VISIBLE content */}
              {isStreaming && hasVisibleStreamingText && (
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
              {isStreaming && streamingToolCall && (() => {
                const parsedMetadata = safeJsonParse<ParsedMetadata>(
                  streamingToolCall.metadata,
                  {}
                );
                const toolCalls = parsedMetadata.tool_calls || [];
                const askOrCompleteTool = findAskOrCompleteTool(toolCalls);

                if (askOrCompleteTool) {
                  const args = askOrCompleteTool.arguments || {};
                  const question = args.question || args.result || '';
                  if (!question) return null;

                  return (
                    <View className="mt-2">
                      <SelectableMarkdownText isDark={isDark}>
                        {autoLinkUrls(String(question)).replace(
                          /<((https?:\/\/|mailto:)[^>\s]+)>/g,
                          (_: string, url: string) => `[${url}](${url})`
                        )}
                      </SelectableMarkdownText>
                    </View>
                  );
                }

                // Non-ask/complete tool - show tool card
                const firstToolCall = toolCalls[0];
                if (firstToolCall) {
                  const toolName = getUserFriendlyToolName(firstToolCall.function_name);
                  return (
                    <View className="mt-2">
                      <CompactStreamingToolCard toolCall={firstToolCall} toolName={toolName} />
                    </View>
                  );
                }

                return (
                  <View className="mt-2">
                    <CompactStreamingToolCard toolCall={null} toolName="" />
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

export default ThreadContent;
