/**
 * Renders assistant message content from metadata
 * 
 * This module handles rendering of assistant messages by extracting
 * tool calls and text content from the message metadata structure.
 */

import React from 'react';
import { Clock } from 'lucide-react';
import { UnifiedMessage, ParsedMetadata } from '@/components/thread/types';
import { safeJsonParse, getToolIcon, getUserFriendlyToolName } from '@/components/thread/utils';
import { ComposioUrlDetector } from '@/components/thread/content/composio-url-detector';
import { FileAttachmentGrid, FileAttachment } from '@/components/thread/file-attachment';
import { TaskCompletedFeedback } from '@/components/thread/tool-views/shared/TaskCompletedFeedback';
import { PromptExamples } from '@/components/shared/prompt-examples';
import type { Project } from '@/lib/api/threads';
import { AppIcon } from '@/components/thread/tool-views/shared/AppIcon';
import { ApifyApprovalInline } from '@/components/thread/content/ApifyApprovalInline';
import { MediaGenerationInline } from '@/components/thread/content/MediaGenerationInline';

export interface AssistantMessageRendererProps {
  message: UnifiedMessage;
  toolResults?: UnifiedMessage[]; // Tool result messages linked to this assistant message
  onToolClick: (assistantMessageId: string | null, toolName: string, toolCallId?: string) => void;
  onFileClick?: (filePath?: string, filePathList?: string[]) => void;
  sandboxId?: string;
  project?: Project;
  isLatestMessage?: boolean;
  t?: (key: string) => string;
  threadId?: string;
  onPromptFill?: (message: string) => void;
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
    // Try parsing as JSON first (handles JSON stringified arrays like "[\"file1.json\", \"file2.json\"]")
    const trimmed = attachments.trim();
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || 
        (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.filter((a: any) => a && typeof a === 'string' && a.trim().length > 0);
        }
      } catch {
        // Not valid JSON, fall through to comma-separated parsing
      }
    }
    
    // Fallback to comma-separated string parsing
    return attachments.split(',').map(a => a.trim()).filter(a => a.length > 0);
  }
  
  return [];
}

/**
 * Extracts a display parameter from tool call arguments
 */
function getToolCallDisplayParam(toolCall: { arguments?: Record<string, any> }): string {
  const args = toolCall.arguments || {};
  return args.file_path || args.command || args.query || args.url || '';
}

/**
 * Renders an "ask" tool call
 */
function renderAskToolCall(
  toolCall: { arguments?: Record<string, any> },
  index: number,
  props: AssistantMessageRendererProps
): React.ReactNode {
  const { onFileClick, sandboxId, project, isLatestMessage, t, onPromptFill } = props;
  const askText = toolCall.arguments?.text || '';
  const attachments = normalizeAttachments(toolCall.arguments?.attachments);
  const followUpAnswers = normalizeArrayValue(toolCall.arguments?.follow_up_answers);

  return (
    <div key={`ask-${index}`} className="space-y-3 my-1.5">
      <ComposioUrlDetector 
        content={askText} 
        className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" 
      />
      {attachments.length > 0 && (
        <div className="mt-3">
          <FileAttachmentGrid
            attachments={attachments}
            onFileClick={onFileClick}
            sandboxId={sandboxId}
            showPreviews={true}
            collapsed={false}
            project={project}
            standalone={true}
          />
        </div>
      )}
      {isLatestMessage && (
        <div className="flex items-center gap-2 mt-3">
          <Clock className="h-4 w-4 text-orange-500 flex-shrink-0" />
          <p className="text-sm text-muted-foreground">
            {t ? t('thread.waitingForUserResponse') : 'Kortix will proceed to work autonomously after you answer.'}
          </p>
        </div>
      )}
      {isLatestMessage && followUpAnswers.length > 0 && (
        <PromptExamples
          prompts={followUpAnswers.slice(0, 4).map(answer => ({ text: answer }))}
          onPromptClick={(answer) => onPromptFill?.(answer)}
          variant="text"
          showTitle={true}
          title={t ? t('thread.sampleAnswers') : 'Sample answers'}
        />
      )}
    </div>
  );
}

/**
 * Renders a "complete" tool call
 */
function renderCompleteToolCall(
  toolCall: { arguments?: Record<string, any> },
  index: number,
  props: AssistantMessageRendererProps
): React.ReactNode {
  const { onFileClick, sandboxId, project, isLatestMessage, t, onPromptFill, threadId, message } = props;
  const completeText = toolCall.arguments?.text || '';
  const attachments = normalizeAttachments(toolCall.arguments?.attachments);
  const followUpPrompts = normalizeArrayValue(toolCall.arguments?.follow_up_prompts);

  return (
    <div key={`complete-${index}`} className="space-y-3 my-1.5">
      {/* Main content */}
      <ComposioUrlDetector 
        content={completeText} 
        className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" 
      />
      
      {/* Attachments underneath the text */}
      {attachments.length > 0 && (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <span>Task complete</span>
            <span className="text-xs">({attachments.length} {attachments.length === 1 ? 'file' : 'files'})</span>
          </div>
          <FileAttachmentGrid
            attachments={attachments}
            onFileClick={onFileClick}
            sandboxId={sandboxId}
            showPreviews={true}
            collapsed={false}
            project={project}
            standalone={true}
          />
        </div>
      )}
      
      {/* Task completed feedback */}
      <TaskCompletedFeedback
        taskSummary={completeText}
        followUpPrompts={isLatestMessage && followUpPrompts.length > 0 ? followUpPrompts : undefined}
        onFollowUpClick={(prompt) => onPromptFill?.(prompt)}
        samplePromptsTitle={t ? t('thread.samplePrompts') : 'Sample prompts'}
        threadId={threadId}
        messageId={message.message_id}
      />
    </div>
  );
}

/**
 * Renders a regular tool call as a clickable button
 */
function renderRegularToolCall(
  toolCall: { function_name: string; arguments?: Record<string, any>; tool_call_id?: string },
  index: number,
  toolName: string,
  props: AssistantMessageRendererProps
): React.ReactNode {
  const { message, onToolClick } = props;
  const IconComponent = getToolIcon(toolName);
  const paramDisplay = getToolCallDisplayParam(toolCall);
  
  // Use display hint if available, otherwise fallback to friendly name
  const displayName = (toolCall as any)._display_hint || getUserFriendlyToolName(toolName);

  return (
    <div key={`tool-${index}`} className="my-1.5">
      <button
        onClick={() => onToolClick(message.message_id, toolName, toolCall.tool_call_id)}
        className="inline-flex items-center gap-1.5 h-8 px-2 py-1.5 text-xs text-muted-foreground bg-card hover:bg-card/80 rounded-lg transition-colors cursor-pointer border border-neutral-200 dark:border-neutral-700/50 whitespace-nowrap"
      >
        <div className='flex items-center justify-center'>
          <AppIcon toolCall={toolCall} size={14} className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" fallbackIcon={IconComponent} />
        </div>
        <span className="font-mono text-xs text-foreground">{displayName}</span>
        {paramDisplay && (
          <span className="ml-1 text-xs text-muted-foreground truncate max-w-[200px]" title={paramDisplay}>
            {paramDisplay}
          </span>
        )}
      </button>
    </div>
  );
}

export function renderAssistantMessage(props: AssistantMessageRendererProps): React.ReactNode {
  const { message, threadId, toolResults = [] } = props;
  const metadata = safeJsonParse<ParsedMetadata>(message.metadata, {});
  
  const toolCalls = metadata.tool_calls || [];
  // Ensure textContent is a string to prevent React error #301
  const rawTextContent = metadata.text_content;
  const textContent = typeof rawTextContent === 'string' ? rawTextContent : (rawTextContent ? String(rawTextContent) : '');
  
  const contentParts: React.ReactNode[] = [];
  
  // Render text content first (if any)
  if (textContent.trim()) {
    contentParts.push(
      <div key="text-content" className="my-1.5">
        <ComposioUrlDetector 
          content={textContent} 
          className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words" 
        />
      </div>
    );
  }
  
  // Check for approval requests in tool calls and render inline
  toolCalls.forEach((toolCall, index) => {
    const toolName = toolCall.function_name.replace(/_/g, '-');
    if (toolName === 'request-apify-approval' || toolName === 'request_apify_approval') {
      // Find matching tool result
      const toolResult = toolResults.find(tr => {
        const trMeta = safeJsonParse<ParsedMetadata>(tr.metadata, {});
        return trMeta.tool_call_id === toolCall.tool_call_id;
      });
      
      if (toolResult && threadId) {
        const trMeta = safeJsonParse<ParsedMetadata>(toolResult.metadata, {});
        const resultData = trMeta.result;
        
        if (resultData?.output && typeof resultData.output === 'object' && resultData.output.approval_id) {
          contentParts.push(
            <ApifyApprovalInline
              key={`approval-${toolCall.tool_call_id}`}
              approval={resultData.output as any}
              threadId={threadId}
            />
          );
        }
      }
    }
  });
  
  // Render tool calls
  toolCalls.forEach((toolCall, index) => {
    const toolName = toolCall.function_name.replace(/_/g, '-');
    
    // Normalize arguments - handle both string and object types
    let normalizedArguments: Record<string, any> = {};
    if (toolCall.arguments) {
      if (typeof toolCall.arguments === 'object' && toolCall.arguments !== null) {
        normalizedArguments = toolCall.arguments;
      } else if (typeof toolCall.arguments === 'string') {
        try {
          normalizedArguments = JSON.parse(toolCall.arguments);
        } catch {
          normalizedArguments = {};
        }
      }
    }
    
    const normalizedToolCall = {
      ...toolCall,
      arguments: normalizedArguments
    };
    
    if (toolName === 'ask') {
      contentParts.push(renderAskToolCall(normalizedToolCall, index, props));
    } else if (toolName === 'complete') {
      contentParts.push(renderCompleteToolCall(normalizedToolCall, index, props));
    } else if (toolName === 'image-edit-or-generate') {
      // Find matching tool result for this call
      const toolResult = toolResults.find(tr => {
        const trMeta = safeJsonParse<ParsedMetadata>(tr.metadata, {});
        return trMeta.tool_call_id === toolCall.tool_call_id;
      });
      
      // Extract result data
      const resultMeta = toolResult ? safeJsonParse<ParsedMetadata>(toolResult.metadata, {}) : null;
      const resultData = resultMeta?.result;
      
      contentParts.push(
        <MediaGenerationInline
          key={`media-gen-${index}`}
          toolCall={normalizedToolCall}
          toolResult={resultData}
          onToolClick={() => props.onToolClick(message.message_id, toolName, toolCall.tool_call_id)}
          sandboxId={props.sandboxId}
          project={props.project}
        />
      );
    } else {
      contentParts.push(renderRegularToolCall(normalizedToolCall, index, toolName, props));
    }
  });
  
  return contentParts.length > 0 ? contentParts : null;
}

