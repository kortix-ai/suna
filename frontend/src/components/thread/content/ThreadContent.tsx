import React, { useRef, useState, useEffect, memo, useMemo } from "react";
import { CircleDashed } from "lucide-react";
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
    const attachmentsMatch = messageContent.match(/\[Uploaded File: (.*?)\]/g);
    const attachmentsList = attachmentsMatch
      ? (attachmentsMatch
          .map((match: string) => {
            const pathMatch = match.match(/\[Uploaded File: (.*?)\]/);
            return pathMatch ? pathMatch[1] : null;
          })
          .filter(Boolean) as string[])
      : [];
    const clean = messageContent.replace(/\[Uploaded File: .*?\]/g, "").trim();
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
  streamingToolCall,
  streamHookStatus,
  agentStatus,
  readOnly,
  visibleMessages,
  streamingText,
  isStreamingText,
  latestMessageRef,
  t,
  threadId,
  onPromptFill,
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
  streamingToolCall?: any;
  streamHookStatus?: string;
  agentStatus: string;
  readOnly: boolean;
  visibleMessages?: UnifiedMessage[];
  streamingText?: string;
  isStreamingText?: boolean;
  latestMessageRef: React.RefObject<HTMLDivElement>;
  t: any;
  threadId?: string;
  onPromptFill?: (message: string) => void;
}) {
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
    const elements: React.ReactNode[] = [];
    let assistantMessageCount = 0;

    group.messages.forEach((message, msgIndex) => {
      if (message.type === "assistant") {
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
    if (
      !isLastGroup ||
      readOnly ||
      !streamingTextContent ||
      (streamHookStatus !== "streaming" && streamHookStatus !== "connecting")
    ) {
      return null;
    }

    let detectedTag: string | null = null;
    let tagStartIndex = -1;

    const askIndex = streamingTextContent.indexOf("<ask");
    const completeIndex = streamingTextContent.indexOf("<complete");
    if (askIndex !== -1 && (completeIndex === -1 || askIndex < completeIndex)) {
      detectedTag = "ask";
      tagStartIndex = askIndex;
    } else if (completeIndex !== -1) {
      detectedTag = "complete";
      tagStartIndex = completeIndex;
    } else {
      const functionCallsIndex =
        streamingTextContent.indexOf("<function_calls>");
      if (functionCallsIndex !== -1) {
        const functionCallsContent =
          streamingTextContent.substring(functionCallsIndex);
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
          const index = streamingTextContent.indexOf(openingTagPattern);
          if (index !== -1) {
            detectedTag = tag;
            tagStartIndex = index;
            break;
          }
        }
      }
    }

    const textToRender = streamingTextContent;
    const textBeforeTag = detectedTag
      ? textToRender.substring(0, tagStartIndex)
      : textToRender;
    const isAskOrComplete = detectedTag === "ask" || detectedTag === "complete";
    const isCurrentlyStreaming =
      streamHookStatus === "streaming" || streamHookStatus === "connecting";

    return (
      <div className="mt-1.5">
        {textBeforeTag && (
          <ComposioUrlDetector
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
              <ComposioUrlDetector
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
    streamingTextContent,
    streamHookStatus,
    visibleMessages,
    handleToolClick,
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
          <ComposioUrlDetector content={textBeforeTag} isStreaming={true} />
        )}
        {detectedTag && isAskOrComplete ? (
          (() => {
            const content = textToRender.substring(tagStartIndex);
            const extractedText = extractTextFromStreamingAskComplete(
              content,
              detectedTag as "ask" | "complete",
            );
            return (
              <ComposioUrlDetector content={extractedText} isStreaming={true} />
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
    if (!isLastGroup || readOnly || !streamingToolCall) return null;

    const parsedMetadata = safeJsonParse<ParsedMetadata>(
      streamingToolCall.metadata,
      {},
    );
    const toolCalls = parsedMetadata.tool_calls || [];

    const askOrCompleteTool = toolCalls.find((tc: any) => {
      const toolName = tc.function_name?.replace(/_/g, "-").toLowerCase() || "";
      return toolName === "ask" || toolName === "complete";
    });

    if (askOrCompleteTool) {
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

      const toolArgs: any = askOrCompleteTool.arguments;
      let askCompleteText = "";
      if (toolArgs) {
        if (typeof toolArgs === "string") {
          try {
            const parsed = JSON.parse(toolArgs);
            askCompleteText = parsed?.text || "";
          } catch {
            askCompleteText = extractTextFromPartialJson(toolArgs);
          }
        } else if (typeof toolArgs === "object" && toolArgs !== null) {
          askCompleteText = toolArgs?.text || "";
        }
      }

      const toolName =
        askOrCompleteTool.function_name?.replace(/_/g, "-").toLowerCase() || "";
      const textToShow =
        askCompleteText || (toolName === "ask" ? "Asking..." : "Completing...");
      const isCurrentlyStreaming =
        streamHookStatus === "streaming" || streamHookStatus === "connecting";

      return (
        <div className="mt-1.5">
          <ComposioUrlDetector
            content={textToShow}
            isStreaming={isCurrentlyStreaming}
          />
        </div>
      );
    }

    const isAskOrComplete = toolCalls.some((tc: any) => {
      const toolName = tc.function_name?.replace(/_/g, "-").toLowerCase() || "";
      return toolName === "ask" || toolName === "complete";
    });

    if (isAskOrComplete) return null;

    return (
      <div className="mt-1.5">
        <div className="flex flex-col gap-2">
          {toolCalls.length > 0 ? (
            toolCalls.map((tc: any, tcIndex: number) => {
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
              <CircleDashed className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 animate-spin animation-duration-2000" />
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
    handleToolClick,
  ]);

  const showLoader = useMemo(() => {
    if (!isLastGroup || readOnly) return false;
    if (agentStatus !== "running" && agentStatus !== "connecting") return false;
    if (streamingTextContent || streamingToolCall) return false;
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
  ]);

  return (
    <div key={group.key} ref={isLastGroup ? latestMessageRef : null}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center">
          <div className="rounded-md flex items-center justify-center relative">
            {agentInfo.avatar}
          </div>
          <p className="ml-2 text-sm text-muted-foreground">{agentInfo.name}</p>
        </div>
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
  streamingTextContent?: string;
  streamingToolCall?: any;
  agentStatus: "idle" | "running" | "connecting" | "error";
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
    streamingToolCall,
    agentStatus,
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

      displayMessages.forEach((message, index) => {
        const messageType = message.type;
        const key = message.message_id || `msg-${index}`;

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
            key: `streaming-group-text`,
          });
        }
      }

      if (streamingToolCall && !streamingTextContent) {
        const lastGroup = mergedGroups.at(-1);
        if (!lastGroup || lastGroup.type === "user") {
          mergedGroups.push({
            type: "assistant_group",
            messages: [],
            key: `streaming-group-tool`,
          });
        }
      }

      if (readOnly && streamingText && isStreamingText) {
        const lastGroup = mergedGroups.at(-1);
        if (!lastGroup || lastGroup.type === "user") {
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
            key: `streaming-group-playback`,
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
            const attachmentsMatch = content.match(/\[Uploaded File: (.*?)\]/g);
            if (attachmentsMatch) {
              attachmentsMatch.forEach((match) => {
                const pathMatch = match.match(/\[Uploaded File: (.*?)\]/);
                if (pathMatch && pathMatch[1]) {
                  allAttachments.push(pathMatch[1]);
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
          {emptyStateComponent || (
            <div className="text-center text-muted-foreground">
              {readOnly
                ? "No messages to display."
                : "Send a message to start."}
            </div>
          )}
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
            streamingToolCall={streamingToolCall}
            streamHookStatus={streamHookStatus}
            agentStatus={agentStatus}
            readOnly={readOnly}
            visibleMessages={visibleMessages}
            streamingText={streamingText}
            isStreamingText={isStreamingText}
            latestMessageRef={latestMessageRef}
            t={t}
            threadId={threadId}
            onPromptFill={onPromptFill}
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
            <div ref={latestMessageRef} className="w-full h-22 rounded mt-6">
              <div className="flex flex-col gap-2">
                <div className="flex items-center">
                  <div className="rounded-md flex items-center justify-center">
                    {agentInfo.avatar}
                  </div>
                  <p className="ml-2 text-sm text-muted-foreground">
                    {agentInfo.name}
                  </p>
                </div>
                <div className="space-y-2 w-full h-12">
                  <AgentLoader />
                </div>
              </div>
            </div>
          )}

          {readOnly && currentToolCall && (
            <div ref={latestMessageRef} className="mt-6">
              <div className="flex flex-col gap-2">
                <div className="flex justify-start">
                  <div className="rounded-md flex items-center justify-center">
                    {agentInfo.avatar}
                  </div>
                  <p className="ml-2 text-sm text-muted-foreground">
                    {agentInfo.name}
                  </p>
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
                    <CircleDashed className="h-3.5 w-3.5 text-primary flex-shrink-0 animate-spin animation-duration-2000 ml-auto" />
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
                  <div className="flex justify-start">
                    <div className="rounded-md flex items-center justify-center">
                      {agentInfo.avatar}
                    </div>
                    <p className="ml-2 text-sm text-muted-foreground">
                      {agentInfo.name}
                    </p>
                  </div>
                  <div className="max-w-[90%] px-4 py-3 text-sm">
                    <div className="flex items-center gap-1.5 py-1">
                      <div className="h-1.5 w-1.5 rounded-full bg-primary/50 animate-pulse" />
                      <div className="h-1.5 w-1.5 rounded-full bg-primary/50 animate-pulse delay-150" />
                      <div className="h-1.5 w-1.5 rounded-full bg-primary/50 animate-pulse delay-300" />
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
