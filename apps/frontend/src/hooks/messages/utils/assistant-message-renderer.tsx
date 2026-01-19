import React from 'react';
import { Clock } from 'lucide-react';
import { UnifiedMessage, ParsedMetadata } from '@/components/thread/types';
import { safeJsonParse, getToolIcon } from '@/components/thread/utils';
import { getUserFriendlyToolName, getCompletedToolName, isHiddenTool } from '@agentpress/shared/tools';
import { normalizeArrayValue, normalizeAttachments } from '@agentpress/shared/utils';
import { ComposioUrlDetector } from '@/components/thread/content/composio-url-detector';
import { FileAttachmentGrid, FileAttachment } from '@/components/thread/file-attachment';
import { TaskCompletedFeedback } from '@/components/thread/tool-views/shared/TaskCompletedFeedback';
import { PromptExamples } from '@/components/shared/prompt-examples';
import type { Project } from '@/lib/api/threads';
import { AppIcon } from '@/components/thread/tool-views/shared/AppIcon';
import { ToolCard } from '@/components/thread/content/ToolCard';
import { ApifyApprovalInline } from '@/components/thread/content/ApifyApprovalInline';
import { MediaGenerationInline } from '@/components/thread/content/MediaGenerationInline';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';

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

const formatElapsedTime = (seconds: number): string => {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(1)} seconds`;
};


function getToolCallDisplayParam(toolCall: { arguments?: Record<string, any> }): string {
  const args = toolCall.arguments || {};
  return args.file_path || args.command || args.query || args.url || '';
}

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

function extractWebSearchUrls(toolResult: UnifiedMessage | undefined): string[] {
  if (!toolResult) return [];
  
  const extractFromOutput = (output: any): string[] => {
    if (!output) return [];
    
    if (output.batch_mode && Array.isArray(output.results)) {
      const allUrls: string[] = [];
      for (const batch of output.results) {
        if (batch.results && Array.isArray(batch.results)) {
          allUrls.push(...batch.results.map((r: any) => r.url).filter(Boolean));
        }
      }
      return allUrls.slice(0, 4);
    }
    
    if (Array.isArray(output.results)) {
      return output.results.slice(0, 4).map((r: any) => r.url).filter(Boolean);
    }
    
    if (Array.isArray(output)) {
      return output.slice(0, 4).map((r: any) => r.url).filter(Boolean);
    }
    
    return [];
  };
  
  try {
    const rawMetadata = toolResult.metadata;
    const metadata = typeof rawMetadata === 'string' 
      ? safeJsonParse<any>(rawMetadata, {})
      : rawMetadata;
    
    if (metadata?.result?.output) {
      return extractFromOutput(metadata.result.output);
    }
    
    if (metadata?.result) {
      return extractFromOutput(metadata.result);
    }
    
    if (metadata?.output) {
      return extractFromOutput(metadata.output);
    }
    
    const rawContent = toolResult.content;
    const content = typeof rawContent === 'string'
      ? safeJsonParse<any>(rawContent, null)
      : rawContent;
      
    if (content) {
      const urls = extractFromOutput(content);
      if (urls.length > 0) return urls;
      
      if (content.output) {
        return extractFromOutput(content.output);
      }
    }
  } catch (e) {
    console.error('extractWebSearchUrls error:', e);
  }
  return [];
}

function extractImageSearchUrls(toolResult: UnifiedMessage | undefined): string[] {
  if (!toolResult) return [];
  
  try {
    const rawMetadata = toolResult.metadata;
    const metadata = typeof rawMetadata === 'string' 
      ? safeJsonParse<any>(rawMetadata, {})
      : rawMetadata;
    
    const output = metadata?.result?.output || metadata?.result || metadata?.output;
    
    if (output) {
      if (output.batch_results && Array.isArray(output.batch_results)) {
        const allImages: string[] = [];
        for (const batch of output.batch_results) {
          if (batch.images && Array.isArray(batch.images)) {
            allImages.push(...batch.images);
          }
        }
        return allImages;
      }
      
      if (Array.isArray(output.images)) {
        return output.images;
      }
    }
    
    const rawContent = toolResult.content;
    const content = typeof rawContent === 'string'
      ? safeJsonParse<any>(rawContent, null)
      : rawContent;
      
    if (content?.images && Array.isArray(content.images)) {
      return content.images;
    }
  } catch (e) {
    console.error('extractImageSearchUrls error:', e);
  }
  return [];
}

export interface SlideInfo {
  presentationName: string;
  slideNumber: number;
  slideTitle: string;
  totalSlides: number;
}

function extractSlideInfo(toolResult: UnifiedMessage | undefined): SlideInfo | undefined {
  if (!toolResult) return undefined;

  try {
    const rawMetadata = toolResult.metadata;
    const metadata = typeof rawMetadata === 'string'
      ? safeJsonParse<any>(rawMetadata, {})
      : rawMetadata;

    const output = metadata?.result?.output || metadata?.result || metadata?.output;

    if (output?.presentation_name && output?.slide_number !== undefined) {
      return {
        presentationName: output.presentation_name,
        slideNumber: output.slide_number,
        slideTitle: output.slide_title || `Slide ${output.slide_number}`,
        totalSlides: output.total_slides || output.slide_number,
      };
    }
  } catch (e) {
    console.error('extractSlideInfo error:', e);
  }
  return undefined;
}

/**
 * Inline slide thumbnail component - renders like image thumbnails
 * Fetches metadata and displays slide preview
 */
function SlideInlineThumbnail({
  slideInfo,
  project,
  onClick,
  isLoading: externalLoading
}: {
  slideInfo?: SlideInfo;
  project?: Project;
  onClick?: () => void;
  isLoading?: boolean;
}) {
  const [iframeLoaded, setIframeLoaded] = React.useState(false);
  const [slideUrl, setSlideUrl] = React.useState<string | null>(null);
  const [isLoadingMetadata, setIsLoadingMetadata] = React.useState(true);

  // Fetch metadata to get proper slide URL
  React.useEffect(() => {
    if (!project?.sandbox?.sandbox_url || !slideInfo?.presentationName) {
      setIsLoadingMetadata(false);
      return;
    }

    const fetchMetadata = async () => {
      try {
        const sanitizedName = slideInfo.presentationName.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
        const metadataUrl = constructHtmlPreviewUrl(
          project.sandbox.sandbox_url,
          `presentations/${sanitizedName}/metadata.json`
        );

        const response = await fetch(`${metadataUrl}?t=${Date.now()}`, {
          cache: 'no-cache',
          headers: { 'Cache-Control': 'no-cache' },
        });

        if (response.ok) {
          const data = await response.json();
          const slideData = data.slides?.[slideInfo.slideNumber];
          if (slideData?.file_path) {
            const url = constructHtmlPreviewUrl(project.sandbox.sandbox_url, slideData.file_path);
            setSlideUrl(url);
          }
        }
      } catch (e) {
        console.error('Failed to load slide metadata:', e);
      } finally {
        setIsLoadingMetadata(false);
      }
    };

    fetchMetadata();
  }, [project?.sandbox?.sandbox_url, slideInfo?.presentationName, slideInfo?.slideNumber]);

  const isLoading = externalLoading || isLoadingMetadata;
  const showShimmer = isLoading || !slideUrl || !iframeLoaded;

  // Shimmer skeleton
  const shimmerElement = (
    <>
      <div className="absolute inset-0 bg-muted" />
      <div className="absolute inset-0 shimmer-slide-inline" />
      <style>{`
        .shimmer-slide-inline {
          background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(128, 128, 128, 0.15) 50%,
            transparent 100%
          );
          background-size: 200% 100%;
          animation: shimmerSlideInline 1.5s infinite;
        }
        @keyframes shimmerSlideInline {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </>
  );

  // 480x270 is exactly 16:9, scale = 480/1920 = 0.25
  const width = 480;
  const height = 270;
  const scale = width / 1920;

  return (
    <button
      onClick={onClick}
      className="relative rounded-lg overflow-hidden bg-muted border border-border hover:opacity-90 transition-opacity cursor-pointer block mt-2"
      style={{ width: `${width}px`, height: `${height}px`, minWidth: `${width}px`, maxWidth: `${width}px` }}
    >
      {showShimmer && shimmerElement}
      {slideUrl && (
        <div style={{ width: `${width}px`, height: `${height}px`, position: 'relative', overflow: 'hidden' }}>
          <iframe
            src={slideUrl}
            title={`Slide ${slideInfo?.slideNumber}`}
            className="border-0 pointer-events-none"
            sandbox="allow-same-origin allow-scripts"
            onLoad={() => setIframeLoaded(true)}
            style={{
              width: '1920px',
              height: '1080px',
              border: 'none',
              display: 'block',
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
              position: 'absolute',
              top: 0,
              left: 0,
              opacity: iframeLoaded ? 1 : 0,
            }}
          />
        </div>
      )}
    </button>
  );
}

/**
 * Renders a slide creation tool call - ToolCard header + preview below
 */
function renderSlideToolCall(
  toolCall: { function_name: string; arguments?: Record<string, any>; tool_call_id?: string },
  index: number,
  props: AssistantMessageRendererProps
): React.ReactNode {
  const { toolResults = [], project, message, onToolClick } = props;

  // Find the tool result for this call
  const toolResult = toolResults.find(tr => {
    const rawMeta = tr.metadata;
    const trMeta = typeof rawMeta === 'string' ? safeJsonParse<any>(rawMeta, {}) : rawMeta;
    return trMeta.tool_call_id === toolCall.tool_call_id;
  });

  const slideInfo = extractSlideInfo(toolResult);
  const isLoading = !toolResult || !slideInfo;
  const toolName = toolCall.function_name.replace(/_/g, '-');
  const IconComponent = getToolIcon(toolName);

  return (
    <div key={`slide-${index}`} className="my-1.5">
      {/* Tool card header */}
      <ToolCard
        toolName={toolName}
        displayName={getCompletedToolName(toolName)}
        toolCall={toolCall}
        toolCallId={toolCall.tool_call_id}
        isStreaming={isLoading}
        fallbackIcon={IconComponent}
        onClick={() => onToolClick(message.message_id, 'create-slide', toolCall.tool_call_id)}
      />
      {/* Slide preview below */}
      <SlideInlineThumbnail
        slideInfo={slideInfo}
        project={project}
        onClick={() => onToolClick(message.message_id, 'create-slide', toolCall.tool_call_id)}
        isLoading={isLoading}
      />
    </div>
  );
}

function renderRegularToolCall(
  toolCall: { function_name: string; arguments?: Record<string, any>; tool_call_id?: string },
  index: number,
  toolName: string,
  props: AssistantMessageRendererProps
): React.ReactNode {
  const { message, onToolClick, toolResults = [] } = props;
  const IconComponent = getToolIcon(toolName);
  
  let websiteUrls: string[] | undefined;
  let imageUrls: string[] | undefined;
  let slideInfo: SlideInfo | undefined;
  let elapsedTime: number | undefined;
  let paramDisplay: string | null = null;
  
  const isWebSearch = toolName === 'web-search' || toolName === 'web_search' || 
                      toolCall.function_name === 'web_search' || toolCall.function_name === 'web-search';
  const isImageSearch = toolName === 'image-search' || toolName === 'image_search' || 
                        toolCall.function_name === 'image_search' || toolCall.function_name === 'image-search';
  const isSlideCreate = toolName === 'create-slide' || toolName === 'create_slide' ||
                        toolCall.function_name === 'create_slide' || toolCall.function_name === 'create-slide';
  
  if (isWebSearch || isImageSearch || isSlideCreate) {
    const toolResult = toolResults.find(tr => {
      const rawMeta = tr.metadata;
      const trMeta = typeof rawMeta === 'string' ? safeJsonParse<any>(rawMeta, {}) : rawMeta;
      return trMeta.tool_call_id === toolCall.tool_call_id;
    });
    
    if (isWebSearch) {
      websiteUrls = extractWebSearchUrls(toolResult);
    }
    
    if (isImageSearch) {
      imageUrls = extractImageSearchUrls(toolResult);
    }
    
    if (isSlideCreate) {
      slideInfo = extractSlideInfo(toolResult);
    }
    
    if (toolResult) {
      const rawMeta = toolResult.metadata;
      const metadata = typeof rawMeta === 'string' ? safeJsonParse<any>(rawMeta, {}) : rawMeta;
      elapsedTime = metadata?.result?.output?.response_time;
    }
  } else {
    paramDisplay = getToolCallDisplayParam(toolCall);
  }

  const baseDisplayName = (toolCall as any)._display_hint || getCompletedToolName(toolName);
  const displayName = elapsedTime !== undefined 
    ? `${baseDisplayName} for ${formatElapsedTime(elapsedTime)}`
    : baseDisplayName;

  return (
    <div key={`tool-${index}`} className="my-1.5">
      <ToolCard
        toolName={toolName}
        displayName={displayName}
        toolCall={toolCall}
        toolCallId={toolCall.tool_call_id}
        paramDisplay={paramDisplay}
        fallbackIcon={IconComponent}
        onClick={() => onToolClick(message.message_id, toolName, toolCall.tool_call_id)}
        websiteUrls={websiteUrls}
        imageUrls={imageUrls}
        slideInfo={slideInfo}
        project={props.project}
      />
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

  // Check if ask/complete tool has the same text as text_content - if so, skip text_content
  // to avoid rendering the same content twice
  const askOrCompleteTool = toolCalls.find((tc: any) => {
    const name = (tc.function_name || '').replace(/_/g, '-');
    return name === 'ask' || name === 'complete';
  });

  let askCompleteText = '';
  if (askOrCompleteTool?.arguments) {
    const args = askOrCompleteTool.arguments;
    if (typeof args === 'string') {
      try {
        askCompleteText = JSON.parse(args)?.text || '';
      } catch {
        askCompleteText = '';
      }
    } else if (typeof args === 'object' && args !== null) {
      askCompleteText = args.text || '';
    }
  }

  // Only render text_content if it's different from ask/complete text
  const shouldRenderTextContent = textContent.trim() && textContent.trim() !== askCompleteText.trim();

  if (shouldRenderTextContent) {
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
    
    // Skip hidden tools (internal/initialization tools that don't provide meaningful user feedback)
    if (isHiddenTool(toolName)) {
      return;
    }
    
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
    } else if (toolName === 'create-slide' || toolName === 'create_slide') {
      // Render slide inline without header (like images)
      contentParts.push(renderSlideToolCall(normalizedToolCall, index, props));
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
