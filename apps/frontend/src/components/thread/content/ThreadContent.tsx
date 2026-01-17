import React, { useRef, useState, useEffect, memo, useMemo } from "react";
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
import { debugLog } from "@/lib/debug-logger";

export function renderAttachments(
  attachments: string[],
  fileViewerHandler?: (filePath?: string, filePathList?: string[]) => void,
  sandboxId?: string,
  project?: Project,
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
}: {
  message: UnifiedMessage;
  groupKey: string;
  handleOpenFileViewer: (filePath?: string, filePathList?: string[]) => void;
  sandboxId?: string;
  project?: Project;
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
  useEffect(() => {
    const wasActive = prevAgentActiveRef.current;
    const isNowActive = isAgentActive;
    prevAgentActiveRef.current = isNowActive;

    // Agent just started - clear refs for fresh content
    if (!wasActive && isNowActive && isLastGroup) {
      lastTextContentRef.current = "";
      lastReasoningContentRef.current = "";
    }
  }, [isAgentActive, isLastGroup]);

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
    if (!streamingToolCall) return "";
    
    const parsedMetadata = safeJsonParse<any>(streamingToolCall.metadata, {});
    const parsedContent = safeJsonParse<any>(streamingToolCall.content, {});
    
    if (parsedMetadata.function_name) {
      const toolName = parsedMetadata.function_name.replace(/_/g, "-").toLowerCase();
      if (toolName === "ask" || toolName === "complete") {
        const toolArgs = parsedContent.arguments;
        if (toolArgs) {
          let extractedText = "";
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
          if (extractedText) return extractedText;
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
    if (!askOrCompleteTool) return "";
    
    // Try arguments first (accumulated), then arguments_delta (streaming)
    let toolArgs: any = askOrCompleteTool.arguments;
    if (!toolArgs || (typeof toolArgs === "object" && Object.keys(toolArgs).length === 0)) {
      toolArgs = askOrCompleteTool.arguments_delta;
    }
    
    if (!toolArgs) return "";
    
    let extractedText = "";
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
    
    return extractedText;
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

  const renderedMessages = useMemo(() => {
    debugLog('[renderedMessages] Computing for group', {
      groupKey: group.key,
      isLastGroup,
      messageCount: group.messages.length,
      messageIds: group.messages.map(m => ({ id: m.message_id?.slice(-8), type: m.type })),
    });

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
  ]);

  const streamingContent = useMemo(() => {
    // Render streaming content for the last group when there's content
    const isStreaming = streamHookStatus === "streaming" || streamHookStatus === "connecting";
    const isAgentRunning = agentStatus === "running" || agentStatus === "connecting";

    debugLog('[streamingContent] Evaluating', {
      groupKey: group.key,
      isLastGroup,
      readOnly,
      rawStreamingTextLength: streamingTextContent?.length || 0,
      smoothedTextLength: displayStreamingText?.length || 0,
      isStreaming,
      isAgentRunning,
      streamHookStatus,
      agentStatus,
      groupMessagesCount: group.messages.length,
      groupMessageIds: group.messages.map(m => ({ id: m.message_id?.slice(-8), type: m.type })),
    });

    // Only render for last group in non-readonly mode with content
    if (!isLastGroup || readOnly || !displayStreamingText) {
      debugLog('[streamingContent] Returning null', { reason: 'not last group, readonly, or no content' });
      return null;
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
    const persistedAssistantWithContent = group.messages.find(m => {
      if (m.type !== "assistant") return false;
      if (m.message_id === "streamingTextContent" || m.message_id === "playbackStreamingText") return false;
      const content = safeJsonParse<ParsedContent>(m.content, { content: '' });
      const textContent = content.content || m.content || '';
      return typeof textContent === 'string' && textContent.trim().length > 0;
    });

    debugLog('[streamingContent] persisted check', {
      hasRealPersistedMessage,
      hasAssistantWithContent: !!persistedAssistantWithContent,
      messageId: persistedAssistantWithContent?.message_id?.slice(-8),
      isStreaming,
      isAgentRunning,
      streamingTextLength: displayStreamingText.trim().length,
    });

    // If agent is idle and we have persisted messages with actual text content,
    // let renderedMessages handle it - no need for streaming content anymore
    if (!isStreaming && !isAgentRunning && persistedAssistantWithContent) {
      debugLog('[streamingContent] Returning null', {
        reason: 'agent idle and has persisted assistant with text content',
      });
      return null;
    }

    // If agent is idle and persisted messages exist but have NO text content,
    // check if there's an ask/complete tool that will render the text
    if (!isStreaming && !isAgentRunning && hasRealPersistedMessage && !persistedAssistantWithContent) {
      const streamingTextLength = displayStreamingText.trim().length;

      // Check if there's an ask or complete tool message - these tools render their own text
      // via renderAskToolCall/renderCompleteToolCall, so we don't need streaming content
      const hasAskOrCompleteTool = group.messages.some(m => {
        if (m.type === "tool") {
          const toolContent = safeJsonParse<{ name?: string }>(m.content, {});
          return toolContent.name === "ask" || toolContent.name === "complete";
        }
        // Also check assistant messages for ask/complete tool calls
        if (m.type === "assistant" && m.message_id !== "streamingTextContent" && m.message_id !== "playbackStreamingText") {
          const meta = safeJsonParse<ParsedMetadata>(m.metadata, {});
          const toolCalls = meta.tool_calls || [];
          return toolCalls.some(tc => {
            const toolName = tc.function_name?.replace(/_/g, '-').toLowerCase();
            return toolName === "ask" || toolName === "complete";
          });
        }
        return false;
      });

      if (hasAskOrCompleteTool) {
        // The ask/complete tool will render the text, no need for streaming content
        debugLog('[streamingContent] Returning null', {
          reason: 'agent idle, has ask/complete tool that will render text',
          streamingTextLength,
        });
        return null;
      }

      if (streamingTextLength <= 5) {
        // Minimal streaming text (probably just tool call) - safe to hide
        debugLog('[streamingContent] Returning null', {
          reason: 'agent idle, has real persisted messages, minimal streaming text',
          streamingTextLength,
        });
        return null;
      }
      // Substantial streaming text but no persisted text content - KEEP showing streaming
      debugLog('[streamingContent] Keeping streaming content', {
        reason: 'agent idle but persisted messages have no text content, keeping streaming text',
        streamingTextLength,
      });
      // Don't return null - continue to render streaming content
    }

    // If still streaming but we have persisted assistant with content, check lengths
    if (persistedAssistantWithContent) {
      const content = safeJsonParse<ParsedContent>(persistedAssistantWithContent.content, { content: '' });
      const persistedText = content.content || persistedAssistantWithContent.content || '';
      const meta = safeJsonParse<ParsedMetadata>(persistedAssistantWithContent.metadata, {});

      const isComplete = meta.stream_status === "complete";
      const persistedIsLongerOrEqual = String(persistedText).trim().length >= displayStreamingText.trim().length;

      if (isComplete || persistedIsLongerOrEqual) {
        debugLog('[streamingContent] Returning null', {
          reason: 'has persisted content that can take over (fallback check)',
          isComplete,
          persistedIsLongerOrEqual,
          persistedLength: String(persistedText).trim().length,
          streamingLength: displayStreamingText.trim().length,
        });
        return null;
      }
    }

    // NOTE: We no longer return null just because agent stopped streaming.
    // We keep showing streaming content until hasPersistedContent is true.
    // This prevents the empty gap between streaming end and server merge.

    debugLog('[streamingContent] Will render streaming content', {});

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
          />
        ) : null}
      </div>
    );
  }, [readOnly, isLastGroup, isStreamingText, streamingText, handleToolClick]);

  const streamingToolCallContent = useMemo(() => {
    // Don't show streaming tool call if not streaming or agent is not running
    if (!isLastGroup || readOnly || !streamingToolCall) return null;
    
    // Don't show if agent is not in a streaming state (unless animation is still playing)
    const isActivelyStreaming = streamHookStatus === "streaming" || streamHookStatus === "connecting";
    const isAgentRunning = agentStatus === "running" || agentStatus === "connecting";
    if (!isActivelyStreaming && !isAgentRunning && !isAskCompleteAnimating) return null;

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
        (m) => m.type === "assistant",
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
  ]);

  const showLoader = useMemo(() => {
    if (!isLastGroup || readOnly) return false;
    if (agentStatus !== "running" && agentStatus !== "connecting") return false;
    if (streamingTextContent || streamingToolCall) return false;
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
    streamingToolCall,
    streamHookStatus,
    group.messages,
    askCompleteText,
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

    debugLog('[reasoningSection] Evaluating', {
      groupKey: group.key,
      isLastGroup,
      readOnly,
      isStreaming,
      isReasoningActive,
      hasStreamingReasoningContent,
      hasPersistedReasoningContent: !!persistedReasoningContent,
      displayReasoningLength: displayReasoningContent?.length || 0,
      persistedReasoningLength: persistedReasoningContent?.length || 0,
    });

    // For last group: prefer streaming content, fall back to persisted
    if (isLastGroup && !readOnly) {
      // Show streaming reasoning if active OR has content (including cached during transition)
      if (isReasoningActive || hasStreamingReasoningContent) {
        // SIMPLE FIX: If agent is idle and we have persisted reasoning, ALWAYS use persisted.
        // This fixes duplication issues where streaming content may be accumulated/duplicated.
        // The persisted content from the server is the source of truth once agent is done.
        const usePersistedInstead = !isStreaming && persistedReasoningContent;

        if (usePersistedInstead) {
          debugLog('[reasoningSection] Using persisted content (agent idle)', {
            persistedLength: persistedReasoningContent.length,
            streamingLength: displayReasoningContent?.length || 0,
          });
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
      debugLog('[baseGroups] Computing groups from displayMessages', {
        count: displayMessages.length,
        messages: displayMessages.map(m => ({ id: m.message_id?.slice(-8), type: m.type })),
      });

      const groups: MessageGroup[] = [];
      let currentGroup: MessageGroup | null = null;
      let assistantGroupCounter = 0;
      // Track processed message IDs and user content to prevent duplicate bubbles
      const processedMessageIds = new Set<string>();
      const processedUserContents = new Set<string>();
      const skippedDuplicates: string[] = [];

      displayMessages.forEach((message, index) => {
        const messageType = message.type;
        const key = message.message_id || `msg-${index}`;

        // Skip duplicate messages (same message_id already processed)
        if (message.message_id && processedMessageIds.has(message.message_id)) {
          skippedDuplicates.push(message.message_id.slice(-8));
          return;
        }

        // For user messages, also skip if we've seen the same content (temp vs server race)
        if (messageType === 'user') {
          const contentKey = String(message.content || '').trim();
          if (contentKey && processedUserContents.has(contentKey)) {
            skippedDuplicates.push(`content:${contentKey.slice(0, 10)}`);
            return;
          }
          if (contentKey) processedUserContents.add(contentKey);
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

      if (skippedDuplicates.length > 0) {
        debugLog('[baseGroups] Skipped duplicates', { ids: skippedDuplicates });
      }

      debugLog('[baseGroups] Result', {
        groupCount: mergedGroups.length,
        groups: mergedGroups.map(g => ({
          type: g.type,
          key: g.key,
          messageCount: g.messages.length,
          messageIds: g.messages.map(m => m.message_id?.slice(-8)),
        })),
      });

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
          className="mx-auto max-w-3xl min-w-0 w-full pl-6 pr-6"
        >
          <div className="space-y-6 min-w-0">
            {groupedMessages.map((group, index) =>
              renderMessageGroup(group, index),
            )}
          </div>

          {showNewGroupLoader && (
            <div ref={latestMessageRef} className="w-full rounded mt-6">
              <div className="flex flex-col gap-2">
                <ReasoningSection
                  content={streamingReasoningContent}
                  isStreaming={true}
                  isReasoningActive={true}
                  isReasoningComplete={false}
                  isPersistedContent={false}
                  isExpanded={newGroupReasoningExpanded}
                  onExpandedChange={setNewGroupReasoningExpanded}
                />
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
