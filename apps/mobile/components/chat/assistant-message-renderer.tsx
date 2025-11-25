/**
 * Renders assistant message content from metadata
 * 
 * This module handles rendering of assistant messages by extracting
 * tool calls and text content from the message metadata structure.
 * Mobile version - mirrors frontend implementation
 */

import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Clock } from 'lucide-react-native';
import type { UnifiedMessage, ParsedMetadata, ParsedContent } from '@/api/types';
import { safeJsonParse } from '@/lib/utils/message-grouping';
import { getToolIcon, getUserFriendlyToolName } from '@/lib/utils/tool-display';
import { isAskOrCompleteTool, extractTextFromArguments } from '@/lib/utils/streaming-utils';
import Markdown from 'react-native-markdown-display';
import { markdownStyles, markdownStylesDark } from '@/lib/utils/markdown-styles';
import { Linking } from 'react-native';
import { FileAttachmentsGrid } from './FileAttachmentRenderer';
import { TaskCompletedFeedback } from './tool-views/complete-tool/TaskCompletedFeedback';
import { parseXmlToolCalls, preprocessTextOnlyTools } from '@/lib/utils/tool-parser';

export interface AssistantMessageRendererProps {
  message: UnifiedMessage;
  onToolClick: (assistantMessageId: string | null, toolName: string) => void;
  onFileClick?: (filePath: string) => void;
  sandboxId?: string;
  isLatestMessage?: boolean;
  threadId?: string;
  onPromptFill?: (message: string) => void;
  isDark?: boolean; // Pass color scheme from parent to avoid hooks violation
}

/**
 * Normalizes an array value that might be a string, array, or other type
 */
function normalizeArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      }
    } catch {
      // If parsing fails, treat as comma-separated string
      return value.split(',').map(a => a.trim()).filter(a => a.length > 0);
    }
  }
  
  return [];
}

/**
 * Normalizes attachments value (can be string, array, or empty)
 */
function normalizeAttachments(attachments: unknown): string[] {
  if (Array.isArray(attachments)) {
    return attachments;
  }
  
  if (typeof attachments === 'string') {
    return attachments.split(',').map(a => a.trim()).filter(a => a.length > 0);
  }
  
  return [];
}

/**
 * Extracts a display parameter from tool call arguments
 */
function getToolCallDisplayParam(toolCall: { arguments?: Record<string, any> | string }): string {
  let args: Record<string, any> = {};
  
  if (toolCall.arguments) {
    if (typeof toolCall.arguments === 'string') {
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        args = {};
      }
    } else {
      args = toolCall.arguments;
    }
  }
  
  return args.file_path || args.path || args.command || args.query || args.url || '';
}

/**
 * Renders an "ask" tool call
 */
function renderAskToolCall(
  toolCall: { arguments?: Record<string, any> | string },
  index: number,
  props: AssistantMessageRendererProps
): React.ReactNode {
  const { onFileClick, sandboxId, isLatestMessage, onPromptFill, isDark = false } = props;
  
  let args: Record<string, any> = {};
  if (toolCall.arguments) {
    if (typeof toolCall.arguments === 'string') {
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        args = {};
      }
    } else {
      args = toolCall.arguments;
    }
  }
  
  const askText = args.text || '';
  const attachments = normalizeAttachments(args.attachments);
  const followUpAnswers = normalizeArrayValue(args.follow_up_answers);

  return (
    <View key={`ask-${index}`} className="space-y-3">
      {askText && (
        <Markdown
          style={isDark ? markdownStylesDark : markdownStyles}
          onLinkPress={(url) => {
            Linking.openURL(url).catch(console.error);
            return false;
          }}
        >
          {askText}
        </Markdown>
      )}
      {attachments.length > 0 && (
        <FileAttachmentsGrid
          filePaths={attachments}
          sandboxId={sandboxId}
          compact={false}
          showPreviews={true}
          onFilePress={onFileClick}
        />
      )}
      {isLatestMessage && (
        <View className="flex-row items-center gap-2">
          <Icon as={Clock} size={16} className="text-orange-500" />
          <Text className="text-sm text-muted-foreground">
            Kortix will proceed to work autonomously after you answer.
          </Text>
        </View>
      )}
      {/* TODO: Add PromptExamples component for mobile if needed */}
    </View>
  );
}

/**
 * Renders a "complete" tool call
 */
function renderCompleteToolCall(
  toolCall: { arguments?: Record<string, any> | string },
  index: number,
  props: AssistantMessageRendererProps
): React.ReactNode {
  const { onFileClick, sandboxId, isLatestMessage, threadId, message, onPromptFill, isDark = false } = props;
  
  let args: Record<string, any> = {};
  if (toolCall.arguments) {
    if (typeof toolCall.arguments === 'string') {
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        args = {};
      }
    } else {
      args = toolCall.arguments;
    }
  }
  
  const completeText = args.text || '';
  const attachments = normalizeAttachments(args.attachments);
  const followUpPrompts = normalizeArrayValue(args.follow_up_prompts);

  return (
    <View key={`complete-${index}`} className="space-y-3">
      {completeText && (
        <Markdown
          style={isDark ? markdownStylesDark : markdownStyles}
          onLinkPress={(url) => {
            Linking.openURL(url).catch(console.error);
            return false;
          }}
        >
          {completeText}
        </Markdown>
      )}
      {attachments.length > 0 && (
        <FileAttachmentsGrid
          filePaths={attachments}
          sandboxId={sandboxId}
          compact={false}
          showPreviews={true}
          onFilePress={onFileClick}
        />
      )}
      <TaskCompletedFeedback
        taskSummary={completeText}
        followUpPrompts={isLatestMessage && followUpPrompts.length > 0 ? followUpPrompts : undefined}
        onFollowUpClick={(prompt) => onPromptFill?.(prompt)}
        threadId={threadId}
        messageId={message.message_id}
      />
    </View>
  );
}

/**
 * Renders a regular tool call as a clickable button
 */
function renderRegularToolCall(
  toolCall: { function_name: string; arguments?: Record<string, any> | string },
  index: number,
  toolName: string,
  props: AssistantMessageRendererProps
): React.ReactNode {
  const { message, onToolClick } = props;
  const IconComponent = getToolIcon(toolName);
  const paramDisplay = getToolCallDisplayParam(toolCall);

  return (
    <View key={`tool-${index}`} className="my-1">
      <Pressable
        onPress={() => onToolClick(message.message_id, toolName)}
        className="inline-flex items-center gap-1.5 py-1 px-1 pr-1.5 text-xs text-muted-foreground bg-muted rounded-lg border border-neutral-200 dark:border-neutral-700/50 active:bg-muted/80"
      >
        <View className='border-2 bg-gradient-to-br from-neutral-200 to-neutral-300 dark:from-neutral-700 dark:to-neutral-800 flex items-center justify-center p-0.5 rounded-sm border-neutral-400/20 dark:border-neutral-600'>
          <Icon as={IconComponent} size={14} className="text-muted-foreground" />
        </View>
        <Text className="font-mono text-xs text-foreground">{getUserFriendlyToolName(toolName)}</Text>
        {paramDisplay && (
          <Text className="ml-1 text-xs text-muted-foreground" numberOfLines={1} style={{ maxWidth: 200 }}>
            {paramDisplay}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

/**
 * Converts XML tool call to unified format
 */
function convertXmlToolCallToUnified(xmlToolCall: { functionName: string; parameters: Record<string, any> }, index: number, messageId: string | null): {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, any>;
  source: 'xml';
} {
  const toolName = xmlToolCall.functionName?.replace(/-/g, '_') || '';
  const toolCallId = messageId ? `xml_tool_index${index}_${messageId}` : `xml_tool_index${index}_${Date.now()}`;
  
  return {
    tool_call_id: toolCallId,
    function_name: toolName,
    arguments: xmlToolCall.parameters || {},
    source: 'xml',
  };
}

/**
 * Renders assistant message content from metadata
 * 
 * Extracts tool calls and text content from message metadata and renders
 * them appropriately (ask/complete tools inline, regular tools as buttons).
 * 
 * Falls back to parsing content for legacy messages that don't have metadata.
 * For legacy messages, extracts XML tool calls and clean text content.
 */

export function renderAssistantMessage(props: AssistantMessageRendererProps): React.ReactNode {
  const { message, isDark = false } = props;
  const metadata = safeJsonParse<ParsedMetadata>(message.metadata, {});
  
  let toolCalls = metadata.tool_calls || [];
  let textContent = metadata.text_content || '';
  
  // Fallback: if no metadata, parse from content (legacy messages)
  if (toolCalls.length === 0 && !textContent) {
    const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
    const contentStr = parsedContent.content || '';
    
    if (typeof contentStr === 'string' && contentStr.trim()) {
      // Try to extract XML tool calls from content
      const xmlToolCalls = parseXmlToolCalls(contentStr);
      
      if (xmlToolCalls.length > 0) {
        // Convert XML tool calls to unified format
        toolCalls = xmlToolCalls.map((xmlTc, idx) => 
          convertXmlToolCallToUnified(xmlTc, idx, message.message_id || null)
        );
        
        // Extract clean text content (without XML tool calls)
        textContent = preprocessTextOnlyTools(contentStr);
      } else {
        // No tool calls, just use the content as text
        textContent = preprocessTextOnlyTools(contentStr);
      }
    }
  }
  
  const contentParts: React.ReactNode[] = [];
  
  // Render text content first (if any)
  if (textContent.trim()) {
    contentParts.push(
      <Markdown
        key="text-content"
        style={isDark ? markdownStylesDark : markdownStyles}
        onLinkPress={(url) => {
          Linking.openURL(url).catch(console.error);
          return false;
        }}
      >
        {textContent}
      </Markdown>
    );
  }
  
  // Render tool calls from metadata (or parsed from XML)
  // Only render ask/complete tools inline - regular tool calls are rendered via ToolCard components
  toolCalls.forEach((toolCall, index) => {
    const toolName = toolCall.function_name?.replace(/_/g, '-') || '';
    
    if (toolName === 'ask') {
      contentParts.push(renderAskToolCall(toolCall, index, props));
    } else if (toolName === 'complete') {
      contentParts.push(renderCompleteToolCall(toolCall, index, props));
    }
    // Regular tool calls are rendered via ToolCard components in ThreadContent, not here
  });
  
  if (contentParts.length === 0) return null;
  
  return (
    <View className="space-y-2">
      {contentParts}
    </View>
  );
}

