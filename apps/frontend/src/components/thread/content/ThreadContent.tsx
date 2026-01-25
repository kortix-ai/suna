import React, { useRef, useState, useEffect, memo, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useTranslations } from "next-intl";
import {
  UnifiedMessage,
  ParsedContent,
  ParsedMetadata,
} from "@/components/thread/types";
import { FileAttachmentGrid } from "@/components/thread/file-attachment";
import { useFilePreloader } from "@/hooks/files";
import { useAuth } from "@/components/AuthProvider";
import { Project } from "@/lib/api/threads";
import {
  safeJsonParse,
  HIDE_STREAMING_XML_TAGS,
  extractUserMessageText,
} from "@/components/thread/utils";
import { KortixLogo } from "@/components/sidebar/kortix-logo";
import { AgentLoader } from "./loader";
import { ShowToolStream } from "./ShowToolStream";
import { ComposioUrlDetector } from "./composio-url-detector";
import {
  renderAssistantMessage,
  extractTextFromPartialJson,
  extractTextFromStreamingAskComplete,
} from "@/hooks/messages/utils";
import { AppIcon } from "../tool-views/shared/AppIcon";
import { useSmoothStream } from "@/lib/streaming/animations";
import { isHiddenTool } from "@agentpress/shared/tools";
import { ReasoningSection } from "./ReasoningSection";
import { StreamingText } from "./StreamingText";
import { MessageActions } from "./MessageActions";

export function renderAttachments(
  attachments: string[],
  fileViewerHandler?: (filePath?: string, filePathList?: string[]) => void,
  sandboxId?: string,
  project?: Project,
  localPreviewUrls?: Record<string, string>,
) {
  if (!attachments || attachments.length === 0) return null;
  const validAttachments = attachments.filter(
    (attachment) => attachment && attachment.trim() !== "",
  );
  if (validAttachments.length === 0) return null;
  return (
    <FileAttachmentGrid
      attachments={validAttachments}
      onFileClick={fileViewerHandler}
      showPreviews={true}
      sandboxId={sandboxId}
      project={project}
      localPreviewUrls={localPreviewUrls}
    />
  );
}

type MessageGroup = {
  type: "user" | "assistant_group";
  messages: UnifiedMessage[];
  key: string;
};

interface AgentInfo {
  name: string;
  avatar: React.ReactNode;
}

// Reusable agent header - shows Kortix logo for Kortix, avatar+name for others
const AgentHeader = memo(function AgentHeader({ agentInfo }: { agentInfo: AgentInfo }) {
  if (agentInfo.name === "Kortix") {
    return (
      <img
        src="/kortix-logomark-white.svg"
        alt="Kortix"
        className="dark:invert-0 invert flex-shrink-0"
        style={{ height: '12px', width: 'auto' }}
      />
    );
  }
  return (
    <>
      <div className="rounded-md flex items-center justify-center">
        {agentInfo.avatar}
      </div>
      <p className="ml-2 text-sm text-muted-foreground">{agentInfo.name}</p>
    </>
  );
});

const UserMessageRow = memo(function UserMessageRow({
  message,
  groupKey,
  handleOpenFileViewer,
  sandboxId,
  project,
  localPreviewUrls = {},
}: {
  message: UnifiedMessage;
  groupKey: string;
  handleOpenFileViewer: (filePath?: string, filePathList?: string[]) => void;
  sandboxId?: string;
  project?: Project;
  localPreviewUrls?: Record<string, string>;
}) {
  const messageContent = useMemo(() => {
    try {
      const parsed = safeJsonParse<ParsedContent>(message.content, {
        content: message.content,
      });
      const content = parsed.content || message.content;
      return typeof content === "string" ? content : String(content || "");
    } catch {
      return typeof message.content === "string"
        ? message.content
        : String(message.content || "");
    }
  }, [message.content]);

  const { cleanContent, attachments } = useMemo(() => {
    // Parse all file reference formats: [Uploaded File: ...], [Attached: ...], [Image: ...]
    const attachmentsMatch = messageContent.match(/\[(?:Uploaded File|Attached|Image): (.*?)\]/g);
    const attachmentsList = attachmentsMatch
      ? (attachmentsMatch
          .map((match: string) => {
            const pathMatch = match.match(/\[(?:Uploaded File|Attached|Image): (.*?)\]/);
            if (!pathMatch) return null;
            // Extract just the path, removing size info if present
            const fullMatch = pathMatch[1];
            const pathOnly = fullMatch.includes(' -> ') 
              ? fullMatch.split(' -> ')[1] 
              : fullMatch;
            return pathOnly;
          })
          .filter(Boolean) as string[])
      : [];
    const clean = messageContent.replace(/\[(?:Uploaded File|Attached|Image): .*?\]/g, "").trim();
    return { cleanContent: clean, attachments: attachmentsList };
  }, [messageContent]);

  return (
    <div key={groupKey} className="flex justify-end">
      <div className="flex max-w-[90%] rounded-3xl rounded-br-lg bg-card border px-4 py-3 break-words overflow-hidden">
        <div className="space-y-2 min-w-0 flex-1">
          {cleanContent && <ComposioUrlDetector content={cleanContent} />}
          {renderAttachments(
            attachments,
            handleOpenFileViewer,
            sandboxId,
            project,
            localPreviewUrls,
          )}
        </div>
      </div>
    </div>
  );
});

const AssistantGroupRow = memo(function AssistantGroupRow({
  group,
  groupIndex,
  isLastGroup,
  agentInfo,
  handleToolClick,
  handleOpenFileViewer,
  sandboxId,
  project,
  streamingTextContent,
  streamingReasoningContent,
  streamingToolCall,
  streamHookStatus,
  agentStatus,
  isReasoningComplete,
  readOnly,
  visibleMessages,
  streamingText,
  isStreamingText,
  latestMessageRef,
  t,
  threadId,
  onPromptFill,
  reasoningExpandedProp,
  onReasoningExpandedChange,
}: {
  group: MessageGroup;
  groupIndex: number;
  isLastGroup: boolean;
  agentInfo: AgentInfo;
  handleToolClick: (
    assistantMessageId: string | null,
    toolName: string,
    toolCallId?: string,
  ) => void;
  handleOpenFileViewer: (filePath?: string, filePathList?: string[]) => void;
  sandboxId?: string;
  project?: Project;
  streamingTextContent?: string;
  streamingReasoningContent?: string;
  streamingToolCall?: any;
  streamHookStatus?: string;
  agentStatus: string;
  isReasoningComplete: boolean;
  readOnly: boolean;
  visibleMessages?: UnifiedMessage[];
  streamingText?: string;
  isStreamingText?: boolean;
  latestMessageRef: React.RefObject<HTMLDivElement>;
  t: any;
  threadId?: string;
  onPromptFill?: (message: string) => void;
  reasoningExpandedProp?: boolean;
  onReasoningExpandedChange?: (expanded: boolean) => void;
}) {
  const isActivelyStreaming = streamHookStatus === "streaming" || streamHookStatus === "connecting";
  const isAgentActive = agentStatus === "running" || agentStatus === "connecting";

  // Persist reasoning expanded state across streaming/persisted transitions
  // Use controlled mode if parent provides props, otherwise use internal state
  const [internalReasoningExpanded, setInternalReasoningExpanded] = useState(false);
  const reasoningExpanded = reasoningExpandedProp ?? internalReasoningExpanded;
  const setReasoningExpanded = onReasoningExpandedChange ?? setInternalReasoningExpanded;

  // Simpler frozen content approach using refs to avoid state timing issues
  // Refs always have the latest value without causing re-renders
  const lastTextContentRef = useRef<string>("");
  const lastReasoningContentRef = useRef<string>("");
  const lastAskCompleteTextRef = useRef<string>("");

  // Always keep refs updated with latest content
  useEffect(() => {
    if (streamingTextContent) {
      lastTextContentRef.current = streamingTextContent;
    }
  }, [streamingTextContent]);

  useEffect(() => {
    if (streamingReasoningContent) {
      lastReasoningContentRef.current = streamingReasoningContent;
    }
  }, [streamingReasoningContent]);

  // Reset refs when agent starts a new turn
  const prevAgentActiveRef = useRef(isAgentActive);

  // Reasoning grace period: When agent starts, briefly delay showing text to allow reasoning to arrive first
  // This prevents the jarring experience of text appearing before the reasoning section
  const REASONING_GRACE_PERIOD_MS = 200;
  const [isInReasoningGracePeriod, setIsInReasoningGracePeriod] = useState(false);
  const gracePeriodTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const wasActive = prevAgentActiveRef.current;
    const isNowActive = isAgentActive;
    prevAgentActiveRef.current = isNowActive;

    // Agent just started - clear refs for fresh content and start grace period
    if (!wasActive && isNowActive && isLastGroup) {
      lastTextContentRef.current = "";
      lastReasoningContentRef.current = "";
      lastAskCompleteTextRef.current = "";

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
  }, [isAgentActive, isLastGroup]);

  // End grace period immediately when reasoning content arrives
  useEffect(() => {
    if (streamingReasoningContent && streamingReasoningContent.trim().length > 0 && isInReasoningGracePeriod) {
      setIsInReasoningGracePeriod(false);
      if (gracePeriodTimeoutRef.current) {
        clearTimeout(gracePeriodTimeoutRef.current);
        gracePeriodTimeoutRef.current = null;
      }
    }
  }, [streamingReasoningContent, isInReasoningGracePeriod]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (gracePeriodTimeoutRef.current) {
        clearTimeout(gracePeriodTimeoutRef.current);
      }
    };
  }, []);

  // Determine the text content to display:
  // - If streaming content exists, use it (live)
  // - Otherwise fall back to last known content (frozen)
  const rawTextContent = useMemo(() => {
    return streamingTextContent || lastTextContentRef.current || "";
  }, [streamingTextContent]);

  // Re-enable smooth text streaming with the raw content
  const displayStreamingText = useSmoothStream(
    rawTextContent,
    isActivelyStreaming,
    300 // animation delay in ms
  );

  // Determine reasoning content to display (same logic as text)
  const displayReasoningContent = useMemo(() => {
    return streamingReasoningContent || lastReasoningContentRef.current || "";
  }, [streamingReasoningContent]);

  const askCompleteText = useMemo(() => {
    if (!streamingToolCall) {
      // No tool call - return cached value to prevent flash during transitions
      return lastAskCompleteTextRef.current;
    }

    const parsedMetadata = safeJsonParse<any>(streamingToolCall.metadata, {});
    const parsedContent = safeJsonParse<any>(streamingToolCall.content, {});

    let extractedText = "";

    if (parsedMetadata.function_name) {
      const toolName = parsedMetadata.function_name.replace(/_/g, "-").toLowerCase();
      if (toolName === "ask" || toolName === "complete") {
        const toolArgs = parsedContent.arguments;
        if (toolArgs) {
          if (typeof toolArgs === "string") {
            try {
              const parsed = JSON.parse(toolArgs);
              extractedText = parsed?.text || "";
            } catch {
              extractedText = extractTextFromPartialJson(toolArgs);
            }
          } else if (typeof toolArgs === "object" && toolArgs !== null) {
            extractedText = toolArgs?.text || "";
          }
          if (extractedText) {
            lastAskCompleteTextRef.current = extractedText;
            return extractedText;
          }
        }
      }
    }

    // Fall back to raw streaming format
    // Structure: metadata.tool_calls[].arguments_delta
    const toolCalls = parsedMetadata.tool_calls || [];
    const askOrCompleteTool = toolCalls.find((tc: any) => {
      const toolName = tc.function_name?.replace(/_/g, "-").toLowerCase() || "";
      return toolName === "ask" || toolName === "complete";
    });
    if (!askOrCompleteTool) {
      // No ask/complete tool found - return cached value
      return lastAskCompleteTextRef.current;
    }

    // Try arguments first (accumulated), then arguments_delta (streaming)
    let toolArgs: any = askOrCompleteTool.arguments;
    if (!toolArgs || (typeof toolArgs === "object" && Object.keys(toolArgs).length === 0)) {
      toolArgs = askOrCompleteTool.arguments_delta;
    }

    if (!toolArgs) {
      // No args yet - return cached value
      return lastAskCompleteTextRef.current;
    }

    if (typeof toolArgs === "string") {
      try {
        const parsed = JSON.parse(toolArgs);
        extractedText = parsed?.text || "";
      } catch {
        // Partial JSON during streaming - extract text field
        extractedText = extractTextFromPartialJson(toolArgs);
      }
    } else if (typeof toolArgs === "object" && toolArgs !== null) {
      extractedText = toolArgs?.text || "";
    }

    // Cache the extracted text for smooth transitions
    if (extractedText) {
      lastAskCompleteTextRef.current = extractedText;
    }

    return extractedText || lastAskCompleteTextRef.current;
  }, [streamingToolCall]);

  // No animation - display ask/complete text immediately
  const isAskCompleteAnimating = false;

  const toolResultsMap = useMemo(() => {
    const map = new Map<string | null, UnifiedMessage[]>();
    group.messages.forEach((msg) => {
      if (msg.type === "tool") {
        const meta = safeJsonParse<ParsedMetadata>(msg.metadata, {});
        const assistantId = meta.assistant_message_id || null;
        if (!map.has(assistantId)) {
          map.set(assistantId, []);
        }
        map.get(assistantId)?.push(msg);
      }
    });
    return map;
  }, [group.messages]);

  const assistantMessages = useMemo(
    () => group.messages.filter((m) => m.type === "assistant"),
    [group.messages],
  );

  const lastAssistantMessageId =
    assistantMessages.length > 0
      ? assistantMessages[assistantMessages.length - 1].message_id
      : null;

  // Aggregate all text content from assistant messages for MessageActions
  const aggregatedTextContent = useMemo(() => {
    const textParts: string[] = [];
    assistantMessages.forEach((message) => {
      const metadata = safeJsonParse<ParsedMetadata>(message.metadata, {});
      if (typeof metadata.text_content === 'string' && metadata.text_content) {
        textParts.push(metadata.text_content);
      }
      // Also extract text from ask/complete tool calls
      const toolCalls = metadata.tool_calls || [];
      toolCalls.forEach((tc: any) => {
        const toolName = tc.function_name?.replace(/_/g, '-') || '';
        if (toolName === 'ask' || toolName === 'complete') {
          let args = tc.arguments || {};
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = {}; }
          }
          if (args.text) {
            textParts.push(args.text);
          }
        }
      });
    });
    return textParts.join('\n\n');
  }, [assistantMessages]);

  const renderedMessages = useMemo(() => {
    const elements: React.ReactNode[] = [];
    let assistantMessageCount = 0;

    group.messages.forEach((message, msgIndex) => {
      if (message.type === "assistant") {
        // Skip fake streaming messages - they are rendered separately by streamingContent
        if (message.message_id === "streamingTextContent" || message.message_id === "playbackStreamingText") return;

        const msgKey = message.message_id || `submsg-assistant-${msgIndex}`;
        const isLatestMessage =
          isLastGroup && message.message_id === lastAssistantMessageId;
        const toolResults = toolResultsMap.get(message.message_id) || [];

        const renderedContent = renderAssistantMessage({
          message,
          toolResults,
          onToolClick: handleToolClick,
          onFileClick: handleOpenFileViewer,
          sandboxId,
          project,
          isLatestMessage,
          t,
          threadId,
          onPromptFill,
        });

        if (!renderedContent) return;

        // Check if currently streaming
        const isCurrentlyStreaming = streamHookStatus === 'streaming' || streamHookStatus === 'connecting';

        // Show actions on last assistant message of this group (not just last group overall)
        const isLastInGroup = message.message_id === lastAssistantMessageId;

        elements.push(
          <div key={msgKey} className={assistantMessageCount > 0 ? "mt-3" : ""}>
            <div className="break-words overflow-hidden">{renderedContent}</div>
          </div>,
        );
        assistantMessageCount++;
      }
    });

    return elements;
  }, [
    group.messages,
    isLastGroup,
    lastAssistantMessageId,
    toolResultsMap,
    handleToolClick,
    handleOpenFileViewer,
    sandboxId,
    project,
    t,
    threadId,
    onPromptFill,
    streamHookStatus,
    aggregatedTextContent,
  ]);

  const streamingContent = useMemo(() => {
    // Render streaming content for the last group when there's content
    const isStreaming = streamHookStatus === "streaming" || streamHookStatus === "connecting";
    const isAgentRunning = agentStatus === "running" || agentStatus === "connecting";

    // Only render for last group in non-readonly mode with content
    if (!isLastGroup || readOnly || !displayStreamingText) {
      return null;
    }

    // During reasoning grace period, don't show text content yet
    // This allows reasoning to arrive first before showing any text
    if (isInReasoningGracePeriod) {
      return null;
    }

    // EARLY CHECK: If agent is idle and there's a persisted ask/complete tool,
    // the ask/complete tool will render its own text via renderAskToolCall/renderCompleteToolCall.
    // We should NOT show streaming content in this case to avoid duplication.
    if (!isStreaming && !isAgentRunning) {
      const hasPersistedAskComplete = group.messages.some(m => {
        if (m.message_id === "streamingTextContent" || m.message_id === "playbackStreamingText") return false;
        if (m.type === "tool") {
          const toolContent = safeJsonParse<{ name?: string }>(m.content, {});
          return toolContent.name === "ask" || toolContent.name === "complete";
        }
        if (m.type === "assistant") {
          const meta = safeJsonParse<ParsedMetadata>(m.metadata, {});
          const toolCalls = meta.tool_calls || [];
          return toolCalls.some(tc => {
            const toolName = tc.function_name?.replace(/_/g, '-').toLowerCase();
            return toolName === "ask" || toolName === "complete";
          });
        }
        return false;
      });
      if (hasPersistedAskComplete) {
        return null;
      }
    }

    // Check if we have ANY real persisted messages (not fake streaming messages)
    // This includes: assistant messages (with or without text) and tool messages
    const hasRealPersistedMessage = group.messages.some(m => {
      // Skip fake streaming messages
      if (m.message_id === "streamingTextContent" || m.message_id === "playbackStreamingText") return false;
      // Accept any assistant or tool message as "real"
      return m.type === "assistant" || m.type === "tool";
    });

    // Also check for assistant with actual text content (for the active streaming case)
    // Check both m.content AND metadata.text_content since renderAssistantMessage uses metadata.text_content
    const persistedAssistantWithContent = group.messages.find(m => {
      if (m.type !== "assistant") return false;
      if (m.message_id === "streamingTextContent" || m.message_id === "playbackStreamingText") return false;

      // Check content field
      const content = safeJsonParse<ParsedContent>(m.content, { content: '' });
      const textFromContent = content.content || (typeof m.content === 'string' ? m.content : '');

      // Check metadata.text_content (this is what renderAssistantMessage uses)
      const meta = safeJsonParse<ParsedMetadata>(m.metadata, {});
      const textFromMetadata = typeof meta.text_content === 'string' ? meta.text_content : '';

      const hasContent = (textFromContent && textFromContent.trim().length > 0) ||
                         (textFromMetadata && textFromMetadata.trim().length > 0);
      return hasContent;
    });

    // If agent is idle and we have persisted messages with actual text content,
    // let renderedMessages handle it - no need for streaming content anymore
    if (!isStreaming && !isAgentRunning && persistedAssistantWithContent) {
      return null;
    }

    // If agent is idle and persisted messages exist but have NO text content,
    // check if there's non-ask/complete tools (ask/complete already handled above)
    if (!isStreaming && !isAgentRunning && hasRealPersistedMessage && !persistedAssistantWithContent) {
      const streamingTextLength = displayStreamingText.trim().length;

      if (streamingTextLength <= 5) {
        // Minimal streaming text (probably just tool call) - safe to hide
        return null;
      }
      // Substantial streaming text but no persisted text content - KEEP showing streaming
    }

    // If still streaming but we have persisted assistant with content, check lengths
    if (persistedAssistantWithContent) {
      const content = safeJsonParse<ParsedContent>(persistedAssistantWithContent.content, { content: '' });
      const meta = safeJsonParse<ParsedMetadata>(persistedAssistantWithContent.metadata, {});

      // Check both content.content and metadata.text_content for persisted text
      const textFromContent = content.content || (typeof persistedAssistantWithContent.content === 'string' ? persistedAssistantWithContent.content : '');
      const textFromMetadata = typeof meta.text_content === 'string' ? meta.text_content : '';
      const persistedText = textFromMetadata || textFromContent || '';

      const isComplete = meta.stream_status === "complete";
      const persistedIsLongerOrEqual = String(persistedText).trim().length >= displayStreamingText.trim().length;

      if (isComplete || persistedIsLongerOrEqual) {
        return null;
      }
    }

    // NOTE: We no longer return null just because agent stopped streaming.
    // We keep showing streaming content until hasPersistedContent is true.
    // This prevents the empty gap between streaming end and server merge.

    let detectedTag: string | null = null;
    let tagStartIndex = -1;

    const askIndex = displayStreamingText.indexOf("<ask");
    const completeIndex = displayStreamingText.indexOf("<complete");
    if (askIndex !== -1 && (completeIndex === -1 || askIndex < completeIndex)) {
      detectedTag = "ask";
      tagStartIndex = askIndex;
    } else if (completeIndex !== -1) {
      detectedTag = "complete";
      tagStartIndex = completeIndex;
    } else {
      const functionCallsIndex =
        displayStreamingText.indexOf("<function_calls>");
      if (functionCallsIndex !== -1) {
        const functionCallsContent =
          displayStreamingText.substring(functionCallsIndex);
        if (
          functionCallsContent.includes('<invoke name="ask"') ||
          functionCallsContent.includes("<invoke name='ask'")
        ) {
          detectedTag = "ask";
          tagStartIndex = functionCallsIndex;
        } else if (
          functionCallsContent.includes('<invoke name="complete"') ||
          functionCallsContent.includes("<invoke name='complete'")
        ) {
          detectedTag = "complete";
          tagStartIndex = functionCallsIndex;
        } else {
          detectedTag = "function_calls";
          tagStartIndex = functionCallsIndex;
        }
      } else {
        for (const tag of HIDE_STREAMING_XML_TAGS) {
          if (tag === "ask" || tag === "complete") continue;
          const openingTagPattern = `<${tag}`;
          const index = displayStreamingText.indexOf(openingTagPattern);
          if (index !== -1) {
            detectedTag = tag;
            tagStartIndex = index;
            break;
          }
        }
      }
    }

    const textToRender = displayStreamingText;
    const textBeforeTag = detectedTag
      ? textToRender.substring(0, tagStartIndex)
      : textToRender;
    const isAskOrComplete = detectedTag === "ask" || detectedTag === "complete";
    // Streaming indicator - no animation delay
    const isCurrentlyStreaming =
      streamHookStatus === "streaming" || streamHookStatus === "connecting";

    return (
      <div className="mt-1.5">
        {textBeforeTag && (
          <StreamingText
            content={textBeforeTag}
            isStreaming={isCurrentlyStreaming}
          />
        )}
        {detectedTag && isAskOrComplete ? (
          (() => {
            const streamingContent = textToRender.substring(tagStartIndex);
            const extractedText = extractTextFromStreamingAskComplete(
              streamingContent,
              detectedTag as "ask" | "complete",
            );
            return (
              <StreamingText
                content={extractedText}
                isStreaming={isCurrentlyStreaming}
              />
            );
          })()
        ) : detectedTag ? (
          <ShowToolStream
            content={textToRender.substring(tagStartIndex)}
            messageId={
              visibleMessages && visibleMessages.length > 0
                ? visibleMessages[visibleMessages.length - 1].message_id
                : "playback-streaming"
            }
            onToolClick={handleToolClick}
            showExpanded={false}
            project={project}
            startTime={Date.now()}
          />
        ) : null}
      </div>
    );
  }, [
    isLastGroup,
    readOnly,
    displayStreamingText,
    streamHookStatus,
    agentStatus,
    visibleMessages,
    handleToolClick,
    group.messages,
    isInReasoningGracePeriod,
  ]);

  const playbackStreamingContent = useMemo(() => {
    if (!readOnly || !isLastGroup || !isStreamingText || !streamingText)
      return null;

    let detectedTag: string | null = null;
    let tagStartIndex = -1;

    const askIndex = streamingText.indexOf("<ask");
    const completeIndex = streamingText.indexOf("<complete");
    if (askIndex !== -1 && (completeIndex === -1 || askIndex < completeIndex)) {
      detectedTag = "ask";
      tagStartIndex = askIndex;
    } else if (completeIndex !== -1) {
      detectedTag = "complete";
      tagStartIndex = completeIndex;
    } else {
      const functionCallsIndex = streamingText.indexOf("<function_calls>");
      if (functionCallsIndex !== -1) {
        const functionCallsContent =
          streamingText.substring(functionCallsIndex);
        if (
          functionCallsContent.includes('<invoke name="ask"') ||
          functionCallsContent.includes("<invoke name='ask'")
        ) {
          detectedTag = "ask";
          tagStartIndex = functionCallsIndex;
        } else if (
          functionCallsContent.includes('<invoke name="complete"') ||
          functionCallsContent.includes("<invoke name='complete'")
        ) {
          detectedTag = "complete";
          tagStartIndex = functionCallsIndex;
        } else {
          detectedTag = "function_calls";
          tagStartIndex = functionCallsIndex;
        }
      } else {
        for (const tag of HIDE_STREAMING_XML_TAGS) {
          if (tag === "ask" || tag === "complete") continue;
          const openingTagPattern = `<${tag}`;
          const index = streamingText.indexOf(openingTagPattern);
          if (index !== -1) {
            detectedTag = tag;
            tagStartIndex = index;
            break;
          }
        }
      }
    }

    const textToRender = streamingText || "";
    const textBeforeTag = detectedTag
      ? textToRender.substring(0, tagStartIndex)
      : textToRender;
    const isAskOrComplete = detectedTag === "ask" || detectedTag === "complete";

    return (
      <div className="mt-1.5">
        {textBeforeTag && (
          <StreamingText content={textBeforeTag} isStreaming={true} />
        )}
        {detectedTag && isAskOrComplete ? (
          (() => {
            const content = textToRender.substring(tagStartIndex);
            const extractedText = extractTextFromStreamingAskComplete(
              content,
              detectedTag as "ask" | "complete",
            );
            return (
              <StreamingText content={extractedText} isStreaming={true} />
            );
          })()
        ) : detectedTag ? (
          <ShowToolStream
            content={textToRender.substring(tagStartIndex)}
            messageId="streamingTextContent"
            onToolClick={handleToolClick}
            showExpanded={false}
            startTime={Date.now()}
            project={project}
          />
        ) : null}
      </div>
    );
  }, [readOnly, isLastGroup, isStreamingText, streamingText, handleToolClick]);

  const streamingToolCallContent = useMemo(() => {
    // Don't show streaming tool call if not streaming or agent is not running
    if (!isLastGroup || readOnly || !streamingToolCall) return null;

    // During reasoning grace period, don't show tool calls yet (especially ask/complete)
    // This allows reasoning to arrive first before showing any content
    if (isInReasoningGracePeriod) return null;

    // Don't show if agent is not in a streaming state (unless we have ask/complete text to show)
    // This prevents flash during transition - keep showing content until persisted messages take over
    const isActivelyStreaming = streamHookStatus === "streaming" || streamHookStatus === "connecting";
    const isAgentRunning = agentStatus === "running" || agentStatus === "connecting";
    const hasAskCompleteContent = askCompleteText && askCompleteText.trim().length > 0;
    if (!isActivelyStreaming && !isAgentRunning && !hasAskCompleteContent) return null;

    const parsedMetadata = safeJsonParse<any>(streamingToolCall.metadata, {});
    const toolCalls = parsedMetadata.tool_calls || [];

    // Check for ask/complete in both formats:
    // 1. Accumulated format: metadata.function_name
    // 2. Raw streaming format: metadata.tool_calls[].function_name
    const isAccumulatedAskComplete = parsedMetadata.function_name && 
      ["ask", "complete"].includes(parsedMetadata.function_name.replace(/_/g, "-").toLowerCase());
    
    const askOrCompleteTool = toolCalls.find((tc: any) => {
      const toolName = tc.function_name?.replace(/_/g, "-").toLowerCase() || "";
      return toolName === "ask" || toolName === "complete";
    });

    if (isAccumulatedAskComplete || askOrCompleteTool) {
      const currentGroupAssistantMessages = group.messages.filter(
        (m) => m.type === "assistant" && m.message_id !== "streamingTextContent" && m.message_id !== "playbackStreamingText",
      );

      // Check if ANY persisted assistant message has an ask/complete tool call
      // If so, and the agent is not actively streaming, the persisted message will handle rendering
      const hasPersistedAskComplete = currentGroupAssistantMessages.some((msg) => {
        const msgMeta = safeJsonParse<ParsedMetadata>(msg.metadata, {});
        const msgToolCalls = msgMeta.tool_calls || [];
        return msgToolCalls.some((tc: any) => {
          const tn = tc.function_name?.replace(/_/g, "-").toLowerCase() || "";
          return tn === "ask" || tn === "complete";
        });
      });

      // If agent is not actively streaming AND there's a persisted ask/complete message,
      // let the persisted message handle rendering (via renderedMessages)
      if (!isActivelyStreaming && !isAgentRunning && hasPersistedAskComplete) {
        return null;
      }

      // Also check the original condition for stream_status=complete
      const lastAssistantMessage =
        currentGroupAssistantMessages.length > 0
          ? currentGroupAssistantMessages[currentGroupAssistantMessages.length - 1]
          : null;
      if (lastAssistantMessage) {
        const lastMsgMetadata = safeJsonParse<ParsedMetadata>(
          lastAssistantMessage.metadata,
          {},
        );
        const lastMsgToolCalls = lastMsgMetadata.tool_calls || [];
        const hasAskOrCompleteInLastMsg = lastMsgToolCalls.some((tc: any) => {
          const tn = tc.function_name?.replace(/_/g, "-").toLowerCase() || "";
          return tn === "ask" || tn === "complete";
        });
        if (
          hasAskOrCompleteInLastMsg &&
          lastMsgMetadata.stream_status === "complete"
        ) {
          return null;
        }
      }

      // Display ask/complete text immediately - no animation delay
      const isCurrentlyStreaming =
        streamHookStatus === "streaming" || streamHookStatus === "connecting";

      // Display text immediately
      if (askCompleteText) {
        return (
          <StreamingText
            content={askCompleteText}
            isStreaming={isCurrentlyStreaming}
          />
        );
      }

      // No text at all yet - return null, the showLoader will handle it
      return null;
    }

    const isAskOrComplete = toolCalls.some((tc: any) => {
      const toolName = tc.function_name?.replace(/_/g, "-").toLowerCase() || "";
      return toolName === "ask" || toolName === "complete";
    });

    if (isAskOrComplete) return null;

    // Get all tool call IDs that are already rendered in completed messages
    const completedToolCallIds = new Set<string>();
    group.messages.forEach((msg) => {
      if (msg.type === "assistant") {
        const msgMeta = safeJsonParse<ParsedMetadata>(msg.metadata, {});
        if (msgMeta.stream_status === "complete" && msgMeta.tool_calls) {
          msgMeta.tool_calls.forEach((tc: any) => {
            if (tc.tool_call_id) {
              completedToolCallIds.add(tc.tool_call_id);
            }
          });
        }
      }
    });

    // Filter out hidden tools, ask/complete tools, AND tools that are already in completed messages
    const visibleToolCalls = toolCalls.filter((tc: any) => {
      const toolName = tc.function_name?.replace(/_/g, "-").toLowerCase() || "";
      const isHidden = isHiddenTool(toolName);
      const isAskComplete = toolName === "ask" || toolName === "complete";
      const isAlreadyCompleted = tc.tool_call_id && completedToolCallIds.has(tc.tool_call_id);
      return !isHidden && !isAskComplete && !isAlreadyCompleted;
    });

    // If all tools were hidden, don't render anything
    if (visibleToolCalls.length === 0 && toolCalls.length > 0) {
      return null;
    }

    return (
      <div className="mt-1.5">
        <div className="flex flex-col gap-2">
          {visibleToolCalls.length > 0 ? (
            visibleToolCalls.map((tc: any, tcIndex: number) => {
              const toolName = tc.function_name?.replace(/_/g, "-") || "";
              const toolCallContent = JSON.stringify({
                function: { name: toolName },
                tool_name: toolName,
                arguments: tc.arguments || {},
              });

              return (
                <ShowToolStream
                  key={tc.tool_call_id || `streaming-tool-${tcIndex}`}
                  content={toolCallContent}
                  messageId={streamingToolCall.message_id || null}
                  onToolClick={handleToolClick}
                  showExpanded={false}
                  toolCall={tc}
                  project={project}
                />
              );
            })
          ) : (
            <button
              onClick={() =>
                handleToolClick(streamingToolCall.message_id || null, "unknown")
              }
              className="inline-flex items-center gap-1.5 h-8 px-2 py-1.5 text-xs text-muted-foreground bg-card hover:bg-card/80 rounded-lg transition-colors cursor-pointer border border-neutral-200 dark:border-neutral-700/50 max-w-full"
            >
              <KortixLoader size="small" />
              <span className="font-mono text-xs text-foreground truncate">
                Using Tool
              </span>
            </button>
          )}
        </div>
      </div>
    );
  }, [
    isLastGroup,
    readOnly,
    streamingToolCall,
    group.messages,
    streamHookStatus,
    agentStatus,
    handleToolClick,
    askCompleteText,
    isInReasoningGracePeriod,
  ]);

  const showLoader = useMemo(() => {
    if (!isLastGroup || readOnly) return false;
    if (agentStatus !== "running" && agentStatus !== "connecting") return false;

    // During grace period, show loader while waiting for reasoning (unless reasoning already arrived)
    if (isInReasoningGracePeriod && !(streamingReasoningContent && streamingReasoningContent.trim().length > 0)) {
      return true;
    }

    if (streamingTextContent || streamingToolCall) return false;
    // Don't show loader if we have reasoning content streaming
    if (streamingReasoningContent && streamingReasoningContent.trim().length > 0) return false;
    // Don't show loader if we have ask/complete text
    if (askCompleteText) return false;
    if (streamHookStatus !== "streaming" && streamHookStatus !== "connecting")
      return false;

    return !group.messages.some((msg) => {
      if (msg.type !== "assistant") return false;
      try {
        const metadata = safeJsonParse<ParsedMetadata>(msg.metadata, {});
        const toolCalls = metadata.tool_calls || [];
        return toolCalls.some((tc: any) => {
          const toolName =
            tc.function_name?.replace(/_/g, "-").toLowerCase() || "";
          return toolName === "ask" || toolName === "complete";
        });
      } catch {
        return false;
      }
    });
  }, [
    isLastGroup,
    readOnly,
    agentStatus,
    streamingTextContent,
    streamingReasoningContent,
    streamingToolCall,
    streamHookStatus,
    group.messages,
    askCompleteText,
    isInReasoningGracePeriod,
  ]);

  // Determine if reasoning is actively happening (agent running, before text response starts)
  const isReasoningActive = useMemo(() => {
    if (!isLastGroup || readOnly) return false;
    const isStreaming = streamHookStatus === "streaming" || streamHookStatus === "connecting";
    const isRunning = agentStatus === "running" || agentStatus === "connecting";
    return isStreaming || isRunning;
  }, [isLastGroup, readOnly, streamHookStatus, agentStatus]);

  // Check if there's reasoning content to display (from streaming, frozen, or cached)
  const hasStreamingReasoningContent = displayReasoningContent.trim().length > 0;

  // Extract persisted reasoning content from the first assistant message in the group
  const persistedReasoningContent = useMemo(() => {
    const firstAssistant = group.messages.find((m) => m.type === "assistant");
    if (!firstAssistant) return null;
    const meta = safeJsonParse<ParsedMetadata>(firstAssistant.metadata, {});
    return meta.reasoning_content || null;
  }, [group.messages]);

  // Display reasoning section when active, has streaming content, or has persisted content
  // Use a consistent key to preserve expanded state across streaming/persisted transitions
  const reasoningSection = useMemo(() => {
    const isStreaming = streamHookStatus === "streaming" || streamHookStatus === "connecting" ||
                        agentStatus === "running" || agentStatus === "connecting";

    // For last group: prefer streaming content, fall back to persisted
    if (isLastGroup && !readOnly) {
      // Only show reasoning section when we actually have streaming reasoning content
      if (hasStreamingReasoningContent) {
        // SIMPLE FIX: If agent is idle and we have persisted reasoning, ALWAYS use persisted.
        // This fixes duplication issues where streaming content may be accumulated/duplicated.
        // The persisted content from the server is the source of truth once agent is done.
        const usePersistedInstead = !isStreaming && persistedReasoningContent;

        if (usePersistedInstead) {
          return (
            <div className="mb-2" key={`reasoning-${group.key}`}>
              <ReasoningSection
                content={persistedReasoningContent}
                isStreaming={false}
                isReasoningActive={false}
                isReasoningComplete={true}
                isPersistedContent={true}
                isExpanded={reasoningExpanded}
                onExpandedChange={setReasoningExpanded}
              />
            </div>
          );
        }

        return (
          <div className="mb-2" key={`reasoning-${group.key}`}>
            <ReasoningSection
              content={displayReasoningContent}
              isStreaming={isStreaming}
              isReasoningActive={isReasoningActive}
              isReasoningComplete={isReasoningComplete}
              isPersistedContent={false}
              isExpanded={reasoningExpanded}
              onExpandedChange={setReasoningExpanded}
            />
          </div>
        );
      }
    }

    // For all groups (including last group after streaming ends): show if persisted reasoning exists
    if (persistedReasoningContent) {
      return (
        <div className="mb-2" key={`reasoning-${group.key}`}>
          <ReasoningSection
            content={persistedReasoningContent}
            isStreaming={false}
            isReasoningActive={false}
            isReasoningComplete={true}
            isPersistedContent={true}
            isExpanded={reasoningExpanded}
            onExpandedChange={setReasoningExpanded}
          />
        </div>
      );
    }

    return null;
  }, [displayReasoningContent, isLastGroup, readOnly, streamHookStatus, agentStatus, isReasoningActive, hasStreamingReasoningContent, isReasoningComplete, persistedReasoningContent, group.key, reasoningExpanded]);

  return (
    <div key={group.key} ref={isLastGroup ? latestMessageRef : null}>
      <div className="flex flex-col gap-2">
        {/* Reasoning section with integrated Kortix icon */}
        {reasoningSection}
        {/* Show AgentHeader only when reasoning section is NOT displayed */}
        {!reasoningSection && (
          <div className="flex items-center">
            <AgentHeader agentInfo={agentInfo} />
          </div>
        )}
        <div className="flex w-full break-words">
          <div className="space-y-1.5 min-w-0 flex-1">
            {renderedMessages}
            {streamingContent}
            {playbackStreamingContent}
            {streamingToolCallContent}
            {showLoader && (
              <div className="mt-1.5">
                <AgentLoader />
              </div>
            )}
            {/* Message actions - show once at the end of the entire assistant block, only when done streaming */}
            {!isLastGroup && aggregatedTextContent && (
              <MessageActions text={aggregatedTextContent} />
            )}
            {isLastGroup && aggregatedTextContent && streamHookStatus !== 'streaming' && streamHookStatus !== 'connecting' && (
              <MessageActions text={aggregatedTextContent} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export interface ThreadContentProps {
  messages: UnifiedMessage[];
  streamingReasoningContent?: string;
  streamingTextContent?: string;
  streamingToolCall?: any;
  agentStatus: "idle" | "running" | "connecting" | "error";
  isReasoningComplete?: boolean;
  handleToolClick: (
    assistantMessageId: string | null,
    toolName: string,
    toolCallId?: string,
  ) => void;
  handleOpenFileViewer: (filePath?: string, filePathList?: string[]) => void;
  readOnly?: boolean;
  visibleMessages?: UnifiedMessage[];
  streamingText?: string;
  isStreamingText?: boolean;
  currentToolCall?: any;
  streamHookStatus?: string;
  sandboxId?: string;
  project?: Project;
  isPreviewMode?: boolean;
  agentName?: string;
  agentAvatar?: React.ReactNode;
  emptyStateComponent?: React.ReactNode;
  threadMetadata?: any;
  scrollContainerRef?: React.RefObject<HTMLDivElement>;
  threadId?: string;
  onPromptFill?: (message: string) => void;
  localPreviewUrls?: Record<string, string>;
}

export const ThreadContent: React.FC<ThreadContentProps> = memo(
  function ThreadContent({
    messages,
    streamingTextContent = "",
    streamingReasoningContent = "",
    streamingToolCall,
    agentStatus,
    isReasoningComplete = false,
    handleToolClick,
    handleOpenFileViewer,
    readOnly = false,
    visibleMessages,
    streamingText = "",
    isStreamingText = false,
    currentToolCall,
    streamHookStatus = "idle",
    sandboxId,
    project,
    isPreviewMode = false,
    agentName = "Kortix",
    agentAvatar = <KortixLogo size={14} />,
    emptyStateComponent,
    threadMetadata,
    scrollContainerRef,
    threadId,
    onPromptFill,
    localPreviewUrls = {}
  }) {
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestMessageRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [shouldJustifyToTop, setShouldJustifyToTop] = useState(false);
    // Track expanded state for new group loader's reasoning section
    const [newGroupReasoningExpanded, setNewGroupReasoningExpanded] = useState(false);
    const { session } = useAuth();
    const t = useTranslations();
    const { preloadFiles } = useFilePreloader();

    const containerClassName = isPreviewMode
      ? "flex-1 overflow-y-auto scrollbar-hide px-4 py-4 pb-0"
      : "flex-1 overflow-y-auto scrollbar-hide px-4 py-4 pb-0 bg-background";

    const displayMessages =
      readOnly && visibleMessages ? visibleMessages : messages;

    const agentInfo = useMemo<AgentInfo>(() => {
      if (threadMetadata?.is_agent_builder) {
        return {
          name: "Worker Builder",
          avatar: (
            <div className="h-5 w-5 flex items-center justify-center rounded text-xs">
              <span className="text-lg">🤖</span>
            </div>
          ),
        };
      }
      const recentAssistantWithAgent = [...displayMessages]
        .reverse()
        .find((msg) => msg.type === "assistant" && msg.agents?.name);
      if (recentAssistantWithAgent?.agents?.name === "Worker Builder") {
        return {
          name: "Worker Builder",
          avatar: (
            <div className="h-5 w-5 flex items-center justify-center rounded text-xs">
              <span className="text-lg">🤖</span>
            </div>
          ),
        };
      }
      if (recentAssistantWithAgent?.agents?.name) {
        const rawName = recentAssistantWithAgent.agents.name;
        const name =
          typeof rawName === "string" ? rawName : String(rawName || "Kortix");
        return {
          name,
          avatar: (
            <div className="h-5 w-5 flex items-center justify-center rounded text-xs">
              <KortixLogo size={14} />
            </div>
          ),
        };
      }
      const fallbackName = typeof agentName === "string" ? agentName : "Kortix";
      return {
        name: fallbackName || "Kortix",
        avatar: agentAvatar,
      };
    }, [threadMetadata, displayMessages, agentName, agentAvatar]);

    const baseGroups = useMemo(() => {
      const groups: MessageGroup[] = [];
      let currentGroup: MessageGroup | null = null;
      let assistantGroupCounter = 0;
      // Track processed message IDs to prevent duplicate bubbles
      const processedMessageIds = new Set<string>();
      // Track temp user message content to detect duplicate temp messages (race conditions)
      const processedTempUserContents = new Set<string>();

      // Build message groups
      displayMessages.forEach((message, index) => {
        const messageType = message.type;
        const key = message.message_id || `msg-${index}`;

        // Skip duplicate messages (same message_id already processed)
        if (message.message_id && processedMessageIds.has(message.message_id)) {
          return;
        }

        // For user messages, perform content-based deduplication ONLY for temp messages
        // Server-confirmed messages (with real UUIDs) are NEVER deduplicated - they represent
        // intentional user actions and should always be displayed
        if (messageType === 'user') {
          const isTemp = message.message_id?.startsWith('temp-');

          // Only deduplicate temp messages - server-confirmed messages are always kept
          if (isTemp) {
            const contentKey = extractUserMessageText(message.content).trim().toLowerCase();

            if (contentKey) {
              const tempCreatedAt = message.created_at ? new Date(message.created_at).getTime() : Date.now();

              // Skip temp message if server already confirmed a message with same content
              // Uses timestamp-aware deduplication: only skip if server message was created within 30 seconds
              const hasMatchingServerVersion = displayMessages.some((existing) => {
                if (existing.type !== 'user') return false;
                if (existing.message_id?.startsWith('temp-')) return false;
                if (extractUserMessageText(existing.content).trim().toLowerCase() !== contentKey) return false;

                const serverCreatedAt = existing.created_at ? new Date(existing.created_at).getTime() : 0;
                return Math.abs(serverCreatedAt - tempCreatedAt) < 30000;
              });

              if (hasMatchingServerVersion) return;

              // Also skip if we already have another temp message with same content (race condition)
              if (processedTempUserContents.has(contentKey)) return;
              processedTempUserContents.add(contentKey);
            }
          }
        }

        if (message.message_id) {
          processedMessageIds.add(message.message_id);
        }

        if (messageType === "user") {
          if (currentGroup) {
            groups.push(currentGroup);
            currentGroup = null;
          }
          groups.push({ type: "user", messages: [message], key });
        } else if (
          messageType === "assistant" ||
          messageType === "tool" ||
          messageType === "browser_state"
        ) {
          const canAddToExistingGroup =
            currentGroup &&
            currentGroup.type === "assistant_group" &&
            (() => {
              if (messageType === "assistant") {
                const lastAssistantMsg = currentGroup!.messages.findLast(
                  (m) => m.type === "assistant",
                );
                if (!lastAssistantMsg) return true;
                return message.agent_id === lastAssistantMsg.agent_id;
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
              type: "assistant_group",
              messages: [message],
              key: `assistant-group-${assistantGroupCounter}`,
            };
          }
        } else if (messageType !== "status") {
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
        if (group.type === "assistant_group") {
          if (
            currentMergedGroup &&
            currentMergedGroup.type === "assistant_group"
          ) {
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

      return mergedGroups;
    }, [displayMessages]);

    const groupedMessages = useMemo(() => {
      const mergedGroups = [...baseGroups];

      // Calculate the next assistant group index for stable keys
      // This ensures the streaming group has the same key as the persisted group will have,
      // preventing React from remounting the component when persisted content arrives
      const existingAssistantGroupCount = mergedGroups.filter(g => g.type === "assistant_group").length;
      const nextAssistantGroupKey = `assistant-group-${existingAssistantGroupCount + 1}`;

      if (streamingTextContent) {
        const lastGroup = mergedGroups.at(-1);
        if (!lastGroup || lastGroup.type === "user") {
          mergedGroups.push({
            type: "assistant_group",
            messages: [
              {
                content: streamingTextContent,
                type: "assistant",
                message_id: "streamingTextContent",
                metadata: "streamingTextContent",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                is_llm_message: true,
                thread_id: "streamingTextContent",
                sequence: Infinity,
              },
            ],
            key: nextAssistantGroupKey,
          });
        }
      }

      if (streamingToolCall && !streamingTextContent) {
        const lastGroup = mergedGroups.at(-1);
        if (!lastGroup || lastGroup.type === "user") {
          mergedGroups.push({
            type: "assistant_group",
            messages: [],
            key: nextAssistantGroupKey,
          });
        }
      }

      if (readOnly && streamingText && isStreamingText) {
        const lastGroup = mergedGroups.at(-1);
        if (!lastGroup || lastGroup.type === "user") {
          // Recalculate in case previous blocks added a group
          const currentAssistantCount = mergedGroups.filter(g => g.type === "assistant_group").length;
          mergedGroups.push({
            type: "assistant_group",
            messages: [
              {
                content: streamingText,
                type: "assistant",
                message_id: "playbackStreamingText",
                metadata: "playbackStreamingText",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                is_llm_message: true,
                thread_id: "playbackStreamingText",
                sequence: Infinity,
              },
            ],
            key: `assistant-group-${currentAssistantCount + 1}`,
          });
        }
      }

      return mergedGroups;
    }, [
      baseGroups,
      streamingTextContent,
      streamingToolCall,
      readOnly,
      streamingText,
      isStreamingText,
    ]);

    const parentRef = scrollContainerRef || messagesContainerRef;

    useEffect(() => {
      const checkContentHeight = () => {
        const container = parentRef.current;
        const content = contentRef.current;
        if (!container || !content) return;
        const containerHeight = container.clientHeight;
        const contentHeight = content.scrollHeight;
        setShouldJustifyToTop(contentHeight <= containerHeight);
      };

      checkContentHeight();
      const resizeObserver = new ResizeObserver(checkContentHeight);
      if (contentRef.current) resizeObserver.observe(contentRef.current);
      if (parentRef.current) resizeObserver.observe(parentRef.current);

      return () => resizeObserver.disconnect();
    }, [displayMessages.length, streamingTextContent, agentStatus, parentRef]);

    useEffect(() => {
      if (!sandboxId || !session?.access_token) return;

      const allAttachments: string[] = [];
      displayMessages.forEach((message) => {
        if (message.type === "user") {
          try {
            const content =
              typeof message.content === "string" ? message.content : "";
            const attachmentsMatch = content.match(/\[(?:Uploaded File|Attached|Image): (.*?)\]/g);
            if (attachmentsMatch) {
              attachmentsMatch.forEach((match) => {
                const pathMatch = match.match(/\[(?:Uploaded File|Attached|Image): (.*?)\]/);
                if (pathMatch && pathMatch[1]) {
                  // Extract just the path, removing size info if present
                  const fullMatch = pathMatch[1];
                  const pathOnly = fullMatch.includes(' -> ') 
                    ? fullMatch.split(' -> ')[1] 
                    : fullMatch;
                  allAttachments.push(pathOnly);
                }
              });
            }
          } catch {}
        }
      });

      if (allAttachments.length > 0) {
        preloadFiles(sandboxId, allAttachments).catch(() => {});
      }
    }, [displayMessages, sandboxId, session?.access_token, preloadFiles]);

    const showNewGroupLoader = useMemo(() => {
      return (
        (agentStatus === "running" || agentStatus === "connecting") &&
        !streamingTextContent &&
        !streamingToolCall &&
        !readOnly &&
        (streamHookStatus === "streaming" ||
          streamHookStatus === "connecting") &&
        (displayMessages.length === 0 ||
          displayMessages[displayMessages.length - 1].type === "user")
      );
    }, [
      agentStatus,
      streamingTextContent,
      streamingToolCall,
      readOnly,
      streamHookStatus,
      displayMessages,
    ]);

    if (
      displayMessages.length === 0 &&
      !streamingTextContent &&
      !streamingToolCall &&
      !streamingText &&
      !currentToolCall &&
      agentStatus === "idle"
    ) {
      return (
        <div className="flex-1 min-h-[60vh] flex items-center justify-center">
          {emptyStateComponent || null}
        </div>
      );
    }

    const renderMessageGroup = (group: MessageGroup, index: number) => {
      const isLastGroup = index === groupedMessages.length - 1;

      // CSS optimization for long lists: skip rendering layout for off-screen items
      const style = !isLastGroup
        ? ({
            contentVisibility: "auto",
            containIntrinsicSize: "100px",
          } as React.CSSProperties)
        : undefined;

      if (group.type === "user") {
        return (
          <div key={group.key} style={style}>
            <UserMessageRow
              message={group.messages[0]}
              groupKey={group.key}
              handleOpenFileViewer={handleOpenFileViewer}
              sandboxId={sandboxId}
              project={project}
              localPreviewUrls={localPreviewUrls}
            />
          </div>
        );
      }

      return (
        <div key={group.key} style={style}>
          <AssistantGroupRow
            group={group}
            groupIndex={index}
            isLastGroup={isLastGroup}
            agentInfo={agentInfo}
            handleToolClick={handleToolClick}
            handleOpenFileViewer={handleOpenFileViewer}
            sandboxId={sandboxId}
            project={project}
            streamingTextContent={streamingTextContent}
            streamingReasoningContent={streamingReasoningContent}
            streamingToolCall={streamingToolCall}
            streamHookStatus={streamHookStatus}
            agentStatus={agentStatus}
            isReasoningComplete={isReasoningComplete}
            readOnly={readOnly}
            visibleMessages={visibleMessages}
            streamingText={streamingText}
            isStreamingText={isStreamingText}
            latestMessageRef={latestMessageRef}
            t={t}
            threadId={threadId}
            onPromptFill={onPromptFill}
            // Share reasoning expanded state with new group loader for the last group
            reasoningExpandedProp={isLastGroup ? newGroupReasoningExpanded : undefined}
            onReasoningExpandedChange={isLastGroup ? setNewGroupReasoningExpanded : undefined}
          />
        </div>
      );
    };

    return (
      <div
        ref={parentRef}
        className={`${containerClassName} min-h-0 flex flex-col-reverse ${shouldJustifyToTop ? "justify-end min-h-full" : ""}`}
      >
        <div
          ref={contentRef}
          className="mx-auto max-w-3xl min-w-0 w-full px-3 sm:px-6"
        >
          <div className="space-y-6 min-w-0">
            {groupedMessages.map((group, index) =>
              renderMessageGroup(group, index),
            )}
          </div>

          {showNewGroupLoader && (
            <div ref={latestMessageRef} className="w-full rounded mt-6">
              <div className="flex flex-col gap-2">
                {/* Smooth transition between loader and reasoning section */}
                <AnimatePresence mode="wait" initial={false}>
                  {streamingReasoningContent && streamingReasoningContent.trim().length > 0 ? (
                    <ReasoningSection
                      key="reasoning-section"
                      content={streamingReasoningContent}
                      isStreaming={streamHookStatus === 'streaming' || streamHookStatus === 'connecting'}
                      isReasoningActive={agentStatus === 'running' || agentStatus === 'connecting'}
                      isReasoningComplete={isReasoningComplete}
                      isPersistedContent={false}
                      isExpanded={newGroupReasoningExpanded}
                      onExpandedChange={setNewGroupReasoningExpanded}
                    />
                  ) : (
                    <motion.div
                      key="loader-section"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15, ease: "easeOut" }}
                      className="w-full"
                    >
                      {/* Match ReasoningSection header layout for smooth transition */}
                      <div className="flex items-center gap-3">
                        <img
                          src="/kortix-logomark-white.svg"
                          alt="Kortix"
                          className="dark:invert-0 invert flex-shrink-0 animate-pulse"
                          style={{ height: '14px', width: 'auto' }}
                        />
                        <div className="flex items-center gap-1.5 py-1">
                          <AgentLoader />
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          )}

          {readOnly && currentToolCall && (
            <div ref={latestMessageRef} className="mt-6">
              <div className="flex flex-col gap-2">
                <div className="flex items-center">
                  <AgentHeader agentInfo={agentInfo} />
                </div>
                <div className="space-y-2">
                  <div className="animate-shimmer inline-flex items-center gap-1.5 py-1.5 px-3 text-xs font-medium text-primary bg-primary/10 rounded-md border border-primary/20">
                    <AppIcon
                      toolCall={currentToolCall}
                      size={14}
                      className="h-3.5 w-3.5 text-primary flex-shrink-0"
                    />
                    <span className="font-mono text-xs text-primary">
                      {currentToolCall.name || "Using Tool"}
                    </span>
                    <KortixLoader size="small" className="ml-auto" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {readOnly &&
            visibleMessages &&
            visibleMessages.length === 0 &&
            isStreamingText && (
              <div ref={latestMessageRef} className="mt-6">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center">
                    <AgentHeader agentInfo={agentInfo} />
                  </div>
                  <div className="max-w-[90%] px-4 py-3 text-sm">
                    <div className="flex items-center gap-1.5 py-1">
                      <div className="h-4 w-4 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
                    </div>
                  </div>
                </div>
              </div>
            )}

          <div className="!h-8" />
        </div>
      </div>
    );
  },
);

export default ThreadContent;
