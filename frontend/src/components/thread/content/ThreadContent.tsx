import React, { useRef, useState, useCallback, useEffect } from 'react';
import { CircleDashed, CheckCircle, AlertTriangle, Info, CheckCircle2, Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { UnifiedMessage, ParsedContent, ParsedMetadata } from '@/components/thread/types';
import { FileAttachmentGrid } from '@/components/thread/file-attachment';
import { useFilePreloader } from '@/hooks/files';
import { useAuth } from '@/components/AuthProvider';
import { Project } from '@/lib/api/threads';
import {
    extractPrimaryParam,
    getToolIcon,
    getUserFriendlyToolName,
    safeJsonParse,
    HIDE_STREAMING_XML_TAGS,
} from '@/components/thread/utils';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { AgentLoader } from './loader';
// Removed XML parsing - we only use metadata now
import { ShowToolStream } from './ShowToolStream';
import { ComposioUrlDetector } from './composio-url-detector';
import { TaskCompletedFeedback } from '@/components/thread/tool-views/shared/TaskCompletedFeedback';
import { PromptExamples } from '@/components/shared/prompt-examples';
import { 
    renderAssistantMessage,
    extractTextFromPartialJson,
    extractTextFromStreamingAskComplete,
    isAskOrCompleteTool,
    extractTextFromArguments,
    findAskOrCompleteTool,
    shouldSkipStreamingRender,
} from '@/hooks/messages/utils';

// Configuration for prompt/answer rendering
const PROMPT_SAMPLES_CONFIG = {
  enableAskSamples: true,
  enableCompleteSamples: true,
} as const;

// Helper function to render attachments (keeping original implementation for now)
export function renderAttachments(attachments: string[], fileViewerHandler?: (filePath?: string, filePathList?: string[]) => void, sandboxId?: string, project?: Project) {
    if (!attachments || attachments.length === 0) return null;

    // Filter out empty strings and check if we have any valid attachments
    const validAttachments = attachments.filter(attachment => attachment && attachment.trim() !== '');
    if (validAttachments.length === 0) return null;

    return <FileAttachmentGrid
        attachments={validAttachments}
        onFileClick={fileViewerHandler}
        showPreviews={true}
        sandboxId={sandboxId}
        project={project}
    />;
}

// NOTE: extractTextFromPartialJson, extractTextFromStreamingAskComplete, isAskOrCompleteTool, etc.
// are now imported from '@/hooks/messages/utils' for portability to mobile

// REMOVED: renderMarkdownContent - we only use renderAssistantMessage now (metadata-only, no XML parsing)

export interface ThreadContentProps {
    messages: UnifiedMessage[];
    streamingTextContent?: string;
    streamingToolCall?: any;
    agentStatus: 'idle' | 'running' | 'connecting' | 'error';
    handleToolClick: (assistantMessageId: string | null, toolName: string) => void;
    handleOpenFileViewer: (filePath?: string, filePathList?: string[]) => void;
    readOnly?: boolean;
    visibleMessages?: UnifiedMessage[]; // For playback mode
    streamingText?: string; // For playback mode
    isStreamingText?: boolean; // For playback mode
    currentToolCall?: any; // For playback mode
    streamHookStatus?: string; // Add this prop
    sandboxId?: string; // Add sandboxId prop
    project?: Project; // Add project prop
    isPreviewMode?: boolean;
    agentName?: string;
    agentAvatar?: React.ReactNode;
    emptyStateComponent?: React.ReactNode; // Add custom empty state component prop
    threadMetadata?: any; // Add thread metadata prop
    scrollContainerRef?: React.RefObject<HTMLDivElement>; // Add scroll container ref prop
    threadId?: string; // Add threadId prop
    onPromptFill?: (message: string) => void; // Handler for filling ChatInput with prompt text from samples
}

export const ThreadContent: React.FC<ThreadContentProps> = ({
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
    agentName = 'Suna',
    agentAvatar = <KortixLogo size={16} />,
    emptyStateComponent,
    threadMetadata,
    scrollContainerRef,
    threadId,
    onPromptFill,
}) => {
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestMessageRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [shouldJustifyToTop, setShouldJustifyToTop] = useState(false);
    const { session } = useAuth();
    const t = useTranslations();

    // React Query file preloader
    const { preloadFiles } = useFilePreloader();

    const containerClassName = isPreviewMode
        ? "flex-1 overflow-y-auto scrollbar-hide px-4 py-4 pb-0"
        : "flex-1 overflow-y-auto scrollbar-hide px-4 py-4 pb-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60";

    // In playback mode, we use visibleMessages instead of messages
    const displayMessages = readOnly && visibleMessages ? visibleMessages : messages;

    // Helper function to get agent info robustly
    const getAgentInfo = useCallback(() => {
        // First check thread metadata for is_agent_builder flag
        if (threadMetadata?.is_agent_builder) {
            return {
                name: 'Agent Builder',
                avatar: (
                    <div className="h-5 w-5 flex items-center justify-center rounded text-xs">
                        <span className="text-lg">🤖</span>
                    </div>
                )
            };
        }

        // Then check recent messages for agent info
        const recentAssistantWithAgent = [...displayMessages].reverse().find(msg =>
            msg.type === 'assistant' && msg.agents?.name
        );

        if (recentAssistantWithAgent?.agents?.name === 'Agent Builder') {
            return {
                name: 'Agent Builder',
                avatar: (
                    <div className="h-5 w-5 flex items-center justify-center rounded text-xs">
                        <span className="text-lg">🤖</span>
                    </div>
                )
            };
        }

        if (recentAssistantWithAgent?.agents?.name) {
            return {
                name: recentAssistantWithAgent.agents.name,
                avatar: (
                    <div className="h-5 w-5 flex items-center justify-center rounded text-xs">
                        <KortixLogo size={16} />
                    </div>
                )
            };
        }
        return {
            name: agentName || 'Suna',
            avatar: agentAvatar
        };
    }, [threadMetadata, displayMessages, agentName, agentAvatar]);

    // Scroll handler - trigger parent scroll detection if needed
    const handleScroll = useCallback(() => {
        // Scroll event will bubble up, parent component handles detection
        // No additional logic needed here
    }, []);

    // No scroll-to-bottom needed with flex-column-reverse

    // No auto-scroll needed with flex-column-reverse - CSS handles it

    // Smart justify-content based on content height
    useEffect(() => {
        const checkContentHeight = () => {
            const container = (scrollContainerRef || messagesContainerRef).current;
            const content = contentRef.current;
            if (!container || !content) return;

            const containerHeight = container.clientHeight;
            const contentHeight = content.scrollHeight;
            setShouldJustifyToTop(contentHeight <= containerHeight);
        };

        checkContentHeight();
        const resizeObserver = new ResizeObserver(checkContentHeight);
        if (contentRef.current) resizeObserver.observe(contentRef.current);
        const containerRef = (scrollContainerRef || messagesContainerRef).current;
        if (containerRef) resizeObserver.observe(containerRef);

        return () => resizeObserver.disconnect();
    }, [displayMessages, streamingTextContent, agentStatus, scrollContainerRef]);

    // Preload all message attachments when messages change or sandboxId is provided
    React.useEffect(() => {
        if (!sandboxId) return;

        // Extract all file attachments from messages
        const allAttachments: string[] = [];

        displayMessages.forEach(message => {
            if (message.type === 'user') {
                try {
                    const content = typeof message.content === 'string' ? message.content : '';
                    const attachmentsMatch = content.match(/\[Uploaded File: (.*?)\]/g);
                    if (attachmentsMatch) {
                        attachmentsMatch.forEach(match => {
                            const pathMatch = match.match(/\[Uploaded File: (.*?)\]/);
                            if (pathMatch && pathMatch[1]) {
                                allAttachments.push(pathMatch[1]);
                            }
                        });
                    }
                } catch (e) {
                    console.error('Error parsing message attachments:', e);
                }
            }
        });

        // Use React Query preloading if we have attachments AND a valid token
        if (allAttachments.length > 0 && session?.access_token) {
            // Preload files with React Query in background
            preloadFiles(sandboxId, allAttachments).catch(err => {
                console.error('React Query preload failed:', err);
            });
        }
    }, [displayMessages, sandboxId, session?.access_token, preloadFiles]);

    return (
        <>
            {displayMessages.length === 0 && !streamingTextContent && !streamingToolCall &&
                !streamingText && !currentToolCall && agentStatus === 'idle' ? (
                // Render empty state outside scrollable container
                <div className="flex-1 min-h-[60vh] flex items-center justify-center">
                    {emptyStateComponent || (
                        <div className="text-center text-muted-foreground">
                            {readOnly ? "No messages to display." : "Send a message to start."}
                        </div>
                    )}
                </div>
            ) : (
                // Render scrollable content container with column-reverse
                <div
                    ref={scrollContainerRef || messagesContainerRef}
                    className={`${containerClassName} min-h-0 flex flex-col-reverse ${shouldJustifyToTop ? 'justify-end min-h-full' : ''}`}
                    onScroll={handleScroll}
                >
                    <div ref={contentRef} className="mx-auto max-w-3xl min-w-0 w-full pl-6 pr-6">
                        <div className="space-y-8 min-w-0">
                            {(() => {

                                type MessageGroup = {
                                    type: 'user' | 'assistant_group';
                                    messages: UnifiedMessage[];
                                    key: string;
                                };
                                const groupedMessages: MessageGroup[] = [];
                                let currentGroup: MessageGroup | null = null;
                                let assistantGroupCounter = 0; // Counter for assistant groups

                                displayMessages.forEach((message, index) => {
                                    const messageType = message.type;
                                    const key = message.message_id || `msg-${index}`;

                                    if (messageType === 'user') {
                                        // Finalize any existing assistant group
                                        if (currentGroup) {
                                            groupedMessages.push(currentGroup);
                                            currentGroup = null;
                                        }
                                        // Create a new user message group
                                        groupedMessages.push({ type: 'user', messages: [message], key });
                                    } else if (messageType === 'assistant' || messageType === 'tool' || messageType === 'browser_state') {
                                        // Check if we can add to existing assistant group (same agent)
                                        const canAddToExistingGroup = currentGroup &&
                                            currentGroup.type === 'assistant_group' &&
                                            (() => {
                                                // For assistant messages, check if agent matches
                                                if (messageType === 'assistant') {
                                                    const lastAssistantMsg = currentGroup.messages.findLast(m => m.type === 'assistant');
                                                    if (!lastAssistantMsg) return true; // No assistant message yet, can add

                                                    // Compare agent info - both null/undefined should be treated as same (default agent)
                                                    const currentAgentId = message.agent_id;
                                                    const lastAgentId = lastAssistantMsg.agent_id;
                                                    return currentAgentId === lastAgentId;
                                                }
                                                // For tool/browser_state messages, always add to current group
                                                return true;
                                            })();

                                        if (canAddToExistingGroup) {
                                            // Add to existing assistant group
                                            currentGroup?.messages.push(message);
                                        } else {
                                            // Finalize any existing group
                                            if (currentGroup) {
                                                groupedMessages.push(currentGroup);
                                            }
                                            // Create a new assistant group with a group-level key
                                            assistantGroupCounter++;
                                            currentGroup = {
                                                type: 'assistant_group',
                                                messages: [message],
                                                key: `assistant-group-${assistantGroupCounter}`
                                            };
                                        }
                                    } else if (messageType !== 'status') {
                                        // For any other message types, finalize current group
                                        if (currentGroup) {
                                            groupedMessages.push(currentGroup);
                                            currentGroup = null;
                                        }
                                    }
                                });

                                // Finalize any remaining group
                                if (currentGroup) {
                                    groupedMessages.push(currentGroup);
                                }

                                // Merge consecutive assistant groups
                                const mergedGroups: MessageGroup[] = [];
                                let currentMergedGroup: MessageGroup | null = null;

                                groupedMessages.forEach((group) => {
                                    if (group.type === 'assistant_group') {
                                        if (currentMergedGroup && currentMergedGroup.type === 'assistant_group') {
                                            // Merge with the current group
                                            currentMergedGroup.messages.push(...group.messages);
                                        } else {
                                            // Finalize previous group if it exists
                                            if (currentMergedGroup) {
                                                mergedGroups.push(currentMergedGroup);
                                            }
                                            // Start new merged group
                                            currentMergedGroup = { ...group };
                                        }
                                    } else {
                                        // Finalize current merged group if it exists
                                        if (currentMergedGroup) {
                                            mergedGroups.push(currentMergedGroup);
                                            currentMergedGroup = null;
                                        }
                                        // Add non-assistant group as-is
                                        mergedGroups.push(group);
                                    }
                                });

                                // Finalize any remaining merged group
                                if (currentMergedGroup) {
                                    mergedGroups.push(currentMergedGroup);
                                }

                                // Use merged groups instead of original grouped messages
                                const finalGroupedMessages = mergedGroups;


                                // Helper function to add streaming content to groups
                                const appendStreamingContent = (content: string, isPlayback: boolean = false) => {
                                    const messageId = isPlayback ? 'playbackStreamingText' : 'streamingTextContent';
                                    const metadata = isPlayback ? 'playbackStreamingText' : 'streamingTextContent';
                                    const keySuffix = isPlayback ? 'playback-streaming' : 'streaming';

                                    const lastGroup = finalGroupedMessages.at(-1);
                                    if (!lastGroup || lastGroup.type === 'user') {
                                        // Create new assistant group for streaming content
                                        assistantGroupCounter++;
                                        finalGroupedMessages.push({
                                            type: 'assistant_group',
                                            messages: [{
                                                content,
                                                type: 'assistant',
                                                message_id: messageId,
                                                metadata,
                                                created_at: new Date().toISOString(),
                                                updated_at: new Date().toISOString(),
                                                is_llm_message: true,
                                                thread_id: messageId,
                                                sequence: Infinity,
                                            }],
                                            key: `assistant-group-${assistantGroupCounter}-${keySuffix}`
                                        });
                                    } else if (lastGroup.type === 'assistant_group') {
                                        // Only add streaming content if it's not already represented in the last message
                                        const lastMessage = lastGroup.messages[lastGroup.messages.length - 1];
                                        if (lastMessage.message_id !== messageId) {
                                            lastGroup.messages.push({
                                                content,
                                                type: 'assistant',
                                                message_id: messageId,
                                                metadata,
                                                created_at: new Date().toISOString(),
                                                updated_at: new Date().toISOString(),
                                                is_llm_message: true,
                                                thread_id: messageId,
                                                sequence: Infinity,
                                            });
                                        }
                                    }
                                };

                                // Handle streaming content - only add to existing group or create new one if needed
                                if (streamingTextContent) {
                                    appendStreamingContent(streamingTextContent, false);
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
                                            key: `assistant-group-${assistantGroupCounter}-streaming-tool`
                                        });
                                    }
                                }

                                // Handle playback mode streaming text
                                if (readOnly && streamingText && isStreamingText) {
                                    appendStreamingContent(streamingText, true);
                                }

                                return finalGroupedMessages.map((group, groupIndex) => {
                                    if (group.type === 'user') {
                                        const message = group.messages[0];
                                        const messageContent = (() => {
                                            try {
                                                const parsed = safeJsonParse<ParsedContent>(message.content, { content: message.content });
                                                return parsed.content || message.content;
                                            } catch {
                                                return message.content;
                                            }
                                        })();

                                        // Extract attachments from the message content
                                        const attachmentsMatch = messageContent.match(/\[Uploaded File: (.*?)\]/g);
                                        const attachments = attachmentsMatch
                                            ? attachmentsMatch.map((match: string) => {
                                                const pathMatch = match.match(/\[Uploaded File: (.*?)\]/);
                                                return pathMatch ? pathMatch[1] : null;
                                            }).filter(Boolean)
                                            : [];

                                        // Remove attachment info from the message content
                                        const cleanContent = messageContent.replace(/\[Uploaded File: .*?\]/g, '').trim();

                                        return (
                                            <div key={group.key} className="flex justify-end">
                                                <div className="flex max-w-[85%] rounded-3xl rounded-br-lg bg-card border px-4 py-3 break-words overflow-hidden">
                                                    <div className="space-y-3 min-w-0 flex-1">
                                                        {cleanContent && (
                                                            <ComposioUrlDetector content={cleanContent} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3 break-words overflow-wrap-anywhere" />
                                                        )}

                                                        {/* Use the helper function to render user attachments */}
                                                        {renderAttachments(attachments as string[], handleOpenFileViewer, sandboxId, project)}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    } else if (group.type === 'assistant_group') {
                                        return (
                                            <div key={group.key} ref={groupIndex === groupedMessages.length - 1 ? latestMessageRef : null}>
                                                <div className="flex flex-col gap-2">
                                                    <div className="flex items-center">
                                                        <div className="rounded-md flex items-center justify-center relative">
                                                            {getAgentInfo().avatar}
                                                        </div>
                                                        <p className='ml-2 text-sm text-muted-foreground'>
                                                            {getAgentInfo().name}
                                                        </p>
                                                    </div>

                                                    {/* Message content - ALL messages in the group */}
                                                    <div className="flex max-w-[90%] text-sm break-words overflow-hidden">
                                                        <div className="space-y-2 min-w-0 flex-1">
                                                            {(() => {
                                                                const toolResultsMap = new Map<string | null, UnifiedMessage[]>();
                                                                group.messages.forEach(msg => {
                                                                    if (msg.type === 'tool') {
                                                                        const meta = safeJsonParse<ParsedMetadata>(msg.metadata, {});
                                                                        const assistantId = meta.assistant_message_id || null;
                                                                        if (!toolResultsMap.has(assistantId)) {
                                                                            toolResultsMap.set(assistantId, []);
                                                                        }
                                                                        toolResultsMap.get(assistantId)?.push(msg);
                                                                    }
                                                                });

                                                                const elements: React.ReactNode[] = [];
                                                                let assistantMessageCount = 0; // Move this outside the loop

                                                                // Check if this is the last group
                                                                const isLastGroup = groupIndex === finalGroupedMessages.length - 1;
                                                                
                                                                // Find the last assistant message in this group
                                                                const assistantMessages = group.messages.filter(m => m.type === 'assistant');
                                                                const lastAssistantMessageId = assistantMessages.length > 0 
                                                                    ? assistantMessages[assistantMessages.length - 1].message_id 
                                                                    : null;

                                                                group.messages.forEach((message, msgIndex) => {
                                                                    if (message.type === 'assistant') {
                                                                        const msgKey = message.message_id || `submsg-assistant-${msgIndex}`;

                                                                        // Check if this is the latest message (last assistant message in the last group)
                                                                        const isLatestMessage = isLastGroup && message.message_id === lastAssistantMessageId;

                                                                        // Use ONLY metadata for rendering
                                                                        const renderedContent = renderAssistantMessage({
                                                                            message,
                                                                            onToolClick: handleToolClick,
                                                                            onFileClick: handleOpenFileViewer,
                                                                            sandboxId,
                                                                            project,
                                                                            isLatestMessage,
                                                                            t,
                                                                            threadId,
                                                                            onPromptFill,
                                                                        });
                                                                        
                                                                        // Skip if no content rendered
                                                                        if (!renderedContent) return;

                                                                        elements.push(
                                                                            <div key={msgKey} className={assistantMessageCount > 0 ? "mt-4" : ""}>
                                                                                <div className="prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3 break-words overflow-hidden">
                                                                                    {renderedContent}
                                                                                </div>
                                                                            </div>
                                                                        );

                                                                        assistantMessageCount++; // Increment after adding the element
                                                                    }
                                                                });

                                                                return elements;
                                                            })()}

                                                            {/* Render streaming text content (XML tool calls or regular text) */}
                                                            {groupIndex === finalGroupedMessages.length - 1 && !readOnly && streamingTextContent && (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') && (
                                                                <div className="mt-2">
                                                                    {(() => {
                                                                        // Detect XML tags in streaming content
                                                                        let detectedTag: string | null = null;
                                                                        let tagStartIndex = -1;
                                                                        
                                                                        // Check for ask/complete tags (XML format)
                                                                        const askIndex = streamingTextContent.indexOf('<ask');
                                                                        const completeIndex = streamingTextContent.indexOf('<complete');
                                                                        if (askIndex !== -1 && (completeIndex === -1 || askIndex < completeIndex)) {
                                                                            detectedTag = 'ask';
                                                                            tagStartIndex = askIndex;
                                                                        } else if (completeIndex !== -1) {
                                                                            detectedTag = 'complete';
                                                                            tagStartIndex = completeIndex;
                                                                        } else {
                                                                            // Check for function_calls format
                                                                            const functionCallsIndex = streamingTextContent.indexOf('<function_calls>');
                                                                            if (functionCallsIndex !== -1) {
                                                                                const functionCallsContent = streamingTextContent.substring(functionCallsIndex);
                                                                                if (functionCallsContent.includes('<invoke name="ask"') || functionCallsContent.includes('<invoke name=\'ask\'')) {
                                                                                    detectedTag = 'ask';
                                                                                    tagStartIndex = functionCallsIndex;
                                                                                } else if (functionCallsContent.includes('<invoke name="complete"') || functionCallsContent.includes('<invoke name=\'complete\'')) {
                                                                                    detectedTag = 'complete';
                                                                                    tagStartIndex = functionCallsIndex;
                                                                                } else {
                                                                                    detectedTag = 'function_calls';
                                                                                    tagStartIndex = functionCallsIndex;
                                                                                }
                                                                            } else {
                                                                                // Check for other tool tags
                                                                                for (const tag of HIDE_STREAMING_XML_TAGS) {
                                                                                    if (tag === 'ask' || tag === 'complete') continue;
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
                                                                        const textBeforeTag = detectedTag ? textToRender.substring(0, tagStartIndex) : textToRender;
                                                                        const isAskOrComplete = detectedTag === 'ask' || detectedTag === 'complete';

                                                                        return (
                                                                            <>
                                                                                {textBeforeTag && (
                                                                                    <ComposioUrlDetector content={textBeforeTag} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3 break-words overflow-wrap-anywhere" />
                                                                                )}

                                                                                {detectedTag && isAskOrComplete ? (
                                                                                    // Extract and render text from XML ask/complete
                                                                                    (() => {
                                                                                        const streamingContent = textToRender.substring(tagStartIndex);
                                                                                        const extractedText = extractTextFromStreamingAskComplete(streamingContent, detectedTag as 'ask' | 'complete');
                                                                                        return (
                                                                                            <ComposioUrlDetector 
                                                                                                content={extractedText} 
                                                                                                className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" 
                                                                                            />
                                                                                        );
                                                                                    })()
                                                                                ) : detectedTag ? (
                                                                                    <ShowToolStream
                                                                                        content={textToRender.substring(tagStartIndex)}
                                                                                        messageId={visibleMessages && visibleMessages.length > 0 ? visibleMessages[visibleMessages.length - 1].message_id : "playback-streaming"}
                                                                                        onToolClick={handleToolClick}
                                                                                        showExpanded={true}
                                                                                        startTime={Date.now()}
                                                                                    />
                                                                                ) : null}
                                                                            </>
                                                                        );
                                                                    })()}
                                                                </div>
                                                            )}

                                                            {/* For playback mode, show streaming text and tool calls */}
                                                            {readOnly && groupIndex === finalGroupedMessages.length - 1 && isStreamingText && (
                                                                <div className="mt-2">
                                                                    {(() => {
                                                                        let detectedTag: string | null = null;
                                                                        let tagStartIndex = -1;
                                                                        if (streamingText) {
                                                                            // First check for ask/complete tags directly (they should render as markdown)
                                                                            const askIndex = streamingText.indexOf('<ask');
                                                                            const completeIndex = streamingText.indexOf('<complete');
                                                                            if (askIndex !== -1 && (completeIndex === -1 || askIndex < completeIndex)) {
                                                                                detectedTag = 'ask';
                                                                                tagStartIndex = askIndex;
                                                                            } else if (completeIndex !== -1) {
                                                                                detectedTag = 'complete';
                                                                                tagStartIndex = completeIndex;
                                                                            } else {
                                                                                // Check for new format function_calls
                                                                                const functionCallsIndex = streamingText.indexOf('<function_calls>');
                                                                                if (functionCallsIndex !== -1) {
                                                                                    // Check if function_calls contains ask or complete
                                                                                    const functionCallsContent = streamingText.substring(functionCallsIndex);
                                                                                    if (functionCallsContent.includes('<invoke name="ask"') || functionCallsContent.includes('<invoke name=\'ask\'')) {
                                                                                        detectedTag = 'ask';
                                                                                        tagStartIndex = functionCallsIndex;
                                                                                    } else if (functionCallsContent.includes('<invoke name="complete"') || functionCallsContent.includes('<invoke name=\'complete\'')) {
                                                                                        detectedTag = 'complete';
                                                                                        tagStartIndex = functionCallsIndex;
                                                                                    } else {
                                                                                        detectedTag = 'function_calls';
                                                                                        tagStartIndex = functionCallsIndex;
                                                                                    }
                                                                                } else {
                                                                                    // Fall back to old format detection
                                                                                    for (const tag of HIDE_STREAMING_XML_TAGS) {
                                                                                        if (tag === 'ask' || tag === 'complete') continue; // Already handled above
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
                                                                        }

                                                                        const textToRender = streamingText || '';
                                                                        const textBeforeTag = detectedTag ? textToRender.substring(0, tagStartIndex) : textToRender;
                                                                        
                                                                        // For ask and complete, render as markdown directly (not as tool stream)
                                                                        const isAskOrComplete = detectedTag === 'ask' || detectedTag === 'complete';

                                                                        return (
                                                                            <>
                                                                                {textBeforeTag && (
                                                                                            <ComposioUrlDetector content={textBeforeTag} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3 break-words overflow-wrap-anywhere" />
                                                                                        )}

                                                                                        {detectedTag && isAskOrComplete ? (
                                                                                            // Extract and render just the text content (strip all XML)
                                                                                            (() => {
                                                                                                const streamingContent = textToRender.substring(tagStartIndex);
                                                                                                const extractedText = extractTextFromStreamingAskComplete(streamingContent, detectedTag as 'ask' | 'complete');
                                                                                                return (
                                                                                                    <ComposioUrlDetector 
                                                                                                        content={extractedText} 
                                                                                                        className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" 
                                                                                                    />
                                                                                                );
                                                                                            })()
                                                                                        ) : detectedTag ? (
                                                                                            <ShowToolStream
                                                                                                content={textToRender.substring(tagStartIndex)}
                                                                                                messageId="streamingTextContent"
                                                                                                onToolClick={handleToolClick}
                                                                                                showExpanded={true}
                                                                                                startTime={Date.now()} // Tool just started now
                                                                                            />
                                                                                        ) : null}
                                                                            </>
                                                                        );
                                                                    })()}
                                                                </div>
                                                            )}

                                                            {/* Show streaming tool call indicator OR streaming ask/complete text inside the last assistant group */}
                                                            {groupIndex === finalGroupedMessages.length - 1 && 
                                                                !readOnly && 
                                                                streamingToolCall && 
                                                                (() => {
                                                                    // Check if this is ask/complete - render as text instead of tool indicator
                                                                    const parsedMetadata = safeJsonParse<ParsedMetadata>(streamingToolCall.metadata, {});
                                                                    const toolCalls = parsedMetadata.tool_calls || [];
                                                                    
                                                                    const askOrCompleteTool = toolCalls.find(tc => {
                                                                        const toolName = tc.function_name?.replace(/_/g, '-').toLowerCase() || '';
                                                                        return toolName === 'ask' || toolName === 'complete';
                                                                    });
                                                                    
                                                                    // For ask/complete, render the text content directly
                                                                    if (askOrCompleteTool) {
                                                                        // Check if the last assistant message already has completed ask/complete
                                                                        const currentGroupAssistantMessages = group.messages.filter(m => m.type === 'assistant');
                                                                        const lastAssistantMessage = currentGroupAssistantMessages.length > 0 
                                                                            ? currentGroupAssistantMessages[currentGroupAssistantMessages.length - 1] 
                                                                            : null;
                                                                        if (lastAssistantMessage) {
                                                                            const lastMsgMetadata = safeJsonParse<ParsedMetadata>(lastAssistantMessage.metadata, {});
                                                                            const lastMsgToolCalls = lastMsgMetadata.tool_calls || [];
                                                                            const hasAskOrCompleteInLastMsg = lastMsgToolCalls.some(tc => {
                                                                                const tn = tc.function_name?.replace(/_/g, '-').toLowerCase() || '';
                                                                                return tn === 'ask' || tn === 'complete';
                                                                            });
                                                                            // If the last message already has ask/complete and is complete, skip
                                                                            if (hasAskOrCompleteInLastMsg && lastMsgMetadata.stream_status === 'complete') {
                                                                                return null;
                                                                            }
                                                                        }
                                                                        
                                                                        // Extract text from arguments
                                                                        const toolArgs: any = askOrCompleteTool.arguments;
                                                                        let askCompleteText = '';
                                                                        if (toolArgs) {
                                                                            if (typeof toolArgs === 'string') {
                                                                                try {
                                                                                    const parsed = JSON.parse(toolArgs);
                                                                                    askCompleteText = parsed?.text || '';
                                                                                } catch (e) {
                                                                                    askCompleteText = extractTextFromPartialJson(toolArgs);
                                                                                }
                                                                            } else if (typeof toolArgs === 'object' && toolArgs !== null) {
                                                                                askCompleteText = toolArgs?.text || '';
                                                                            }
                                                                        }
                                                                        
                                                                        const toolName = askOrCompleteTool.function_name?.replace(/_/g, '-').toLowerCase() || '';
                                                                        const textToShow = askCompleteText || (toolName === 'ask' ? 'Asking...' : 'Completing...');
                                                                        
                                                                        return (
                                                                            <div className="mt-2">
                                                                                <ComposioUrlDetector 
                                                                                    content={textToShow} 
                                                                                    className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" 
                                                                                />
                                                                            </div>
                                                                        );
                                                                    }
                                                                    
                                                                    // For non-ask/complete tools, check if any tool calls exist
                                                                    const isAskOrComplete = toolCalls.some(tc => {
                                                                        const toolName = tc.function_name?.replace(/_/g, '-').toLowerCase() || '';
                                                                        return toolName === 'ask' || toolName === 'complete';
                                                                    });
                                                                    
                                                                    // Don't render tool call indicator for ask/complete - they're handled above
                                                                    if (isAskOrComplete) {
                                                                        return null;
                                                                    }
                                                                    
                                                                    return (
                                                                        <div className="mt-2">
                                                                            <div className="my-1">
                                                                                {(() => {
                                                                                    // Extract tool call info from streamingToolCall metadata
                                                                                    if (toolCalls.length > 0) {
                                                                                        const firstToolCall = toolCalls[0];
                                                                                        const toolName = firstToolCall.function_name?.replace(/_/g, '-') || '';
                                                                                        const IconComponent = getToolIcon(toolName);
                                                                                        
                                                                                        // Extract display parameter (same logic as rendered version)
                                                                                        let paramDisplay = '';
                                                                                        if (firstToolCall.arguments) {
                                                                                            const args = typeof firstToolCall.arguments === 'string' 
                                                                                                ? safeJsonParse<Record<string, any>>(firstToolCall.arguments, {})
                                                                                                : firstToolCall.arguments;
                                                                                            paramDisplay = (args as any)?.file_path || (args as any)?.command || (args as any)?.query || (args as any)?.url || '';
                                                                                        }
                                                                                        
                                                                                        return (
                                                                                            <div className="inline-flex items-center gap-1.5 py-1 px-1 pr-1.5 text-xs text-muted-foreground bg-muted rounded-lg border border-neutral-200 dark:border-neutral-700/50">
                                                                                                <div className='border-2 bg-gradient-to-br from-neutral-200 to-neutral-300 dark:from-neutral-700 dark:to-neutral-800 flex items-center justify-center p-0.5 rounded-sm border-neutral-400/20 dark:border-neutral-600'>
                                                                                                    <CircleDashed className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 animate-spin animation-duration-2000" />
                                                                                                </div>
                                                                                                <span className="font-mono text-xs text-foreground">
                                                                                                    {getUserFriendlyToolName(toolName)}
                                                                                                </span>
                                                                                                {paramDisplay && (
                                                                                                    <span className="ml-1 text-xs text-muted-foreground truncate max-w-[200px]" title={paramDisplay}>
                                                                                                        {paramDisplay}
                                                                                                    </span>
                                                                                                )}
                                                                                            </div>
                                                                                        );
                                                                                    }
                                                                                    
                                                                                    // Fallback if no tool calls found
                                                                                    return (
                                                                                        <div className="inline-flex items-center gap-1.5 py-1 px-1 pr-1.5 text-xs text-muted-foreground bg-muted rounded-lg border border-neutral-200 dark:border-neutral-700/50">
                                                                                            <div className='border-2 bg-gradient-to-br from-neutral-200 to-neutral-300 dark:from-neutral-700 dark:to-neutral-800 flex items-center justify-center p-0.5 rounded-sm border-neutral-400/20 dark:border-neutral-600'>
                                                                                                <CircleDashed className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 animate-spin animation-duration-2000" />
                                                                                            </div>
                                                                                            <span className="font-mono text-xs text-foreground">Using Tool</span>
                                                                                        </div>
                                                                                    );
                                                                                })()}
                                                                            </div>
                                                                        </div>
                                                                    );
                                                                })()}

                                                            {/* Show loader when agent is running but not streaming, inside the last assistant group */}
                                                            {groupIndex === finalGroupedMessages.length - 1 && 
                                                                !readOnly && 
                                                                (agentStatus === 'running' || agentStatus === 'connecting') && 
                                                                !streamingTextContent && 
                                                                !streamingToolCall &&
                                                                (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') && (
                                                                <div className="mt-2">
                                                                    <AgentLoader />
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    }
                                    return null;
                                });
                            })()}

                            {/* Show loader as new assistant group only when there's no assistant group (last message is user or no messages) and agent is running */}
                            {((agentStatus === 'running' || agentStatus === 'connecting') && !streamingTextContent && !streamingToolCall &&
                                !readOnly &&
                                (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') &&
                                (displayMessages.length === 0 || displayMessages[displayMessages.length - 1].type === 'user')) && (
                                    <div ref={latestMessageRef} className='w-full h-22 rounded'>
                                        <div className="flex flex-col gap-2">
                                            {/* Logo positioned above the loader */}
                                            <div className="flex items-center">
                                                <div className="rounded-md flex items-center justify-center">
                                                    {getAgentInfo().avatar}
                                                </div>
                                                <p className='ml-2 text-sm text-muted-foreground'>
                                                    {getAgentInfo().name}
                                                </p>
                                            </div>

                                            {/* Loader content */}
                                            <div className="space-y-2 w-full h-12">
                                                <AgentLoader />
                                            </div>
                                        </div>
                                    </div>
                                )}
                            {readOnly && currentToolCall && (
                                <div ref={latestMessageRef}>
                                    <div className="flex flex-col gap-2">
                                        {/* Logo positioned above the tool call */}
                                        <div className="flex justify-start">
                                            <div className="rounded-md flex items-center justify-center">
                                                {getAgentInfo().avatar}
                                            </div>
                                            <p className='ml-2 text-sm text-muted-foreground'>
                                                {getAgentInfo().name}
                                            </p>
                                        </div>

                                        {/* Tool call content */}
                                        <div className="space-y-2">
                                            <div className="animate-shimmer inline-flex items-center gap-1.5 py-1.5 px-3 text-xs font-medium text-primary bg-primary/10 rounded-md border border-primary/20">
                                                <CircleDashed className="h-3.5 w-3.5 text-primary flex-shrink-0 animate-spin animation-duration-2000" />
                                                <span className="font-mono text-xs text-primary">
                                                    {currentToolCall.name || 'Using Tool'}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* For playback mode - Show streaming indicator if no messages yet */}
                            {readOnly && visibleMessages && visibleMessages.length === 0 && isStreamingText && (
                                <div ref={latestMessageRef}>
                                    <div className="flex flex-col gap-2">
                                        {/* Logo positioned above the streaming indicator */}
                                        <div className="flex justify-start">
                                            <div className="rounded-md flex items-center justify-center">
                                                {getAgentInfo().avatar}
                                            </div>
                                            <p className='ml-2 text-sm text-muted-foreground'>
                                                {getAgentInfo().name}
                                            </p>
                                        </div>

                                        {/* Streaming indicator content */}
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
                </div>
            )}

            {/* No scroll button needed with flex-column-reverse */}
        </>
    );
};

export default ThreadContent; 
