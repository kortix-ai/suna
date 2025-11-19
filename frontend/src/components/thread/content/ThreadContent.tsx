import React, { useRef, useState, useCallback, useEffect } from 'react';
import { CircleDashed, CheckCircle, AlertTriangle, Info, CheckCircle2, Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { UnifiedMessage, ParsedContent, ParsedMetadata } from '@/components/thread/types';
import { FileAttachmentGrid } from '@/components/thread/file-attachment';
import { useFilePreloader } from '@/hooks/files';
import { useAuth } from '@/components/AuthProvider';
import { Project } from '@/lib/api/projects';
import {
    extractPrimaryParam,
    getToolIcon,
    getUserFriendlyToolName,
    safeJsonParse,
    HIDE_STREAMING_XML_TAGS,
} from '@/components/thread/utils';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { AgentLoader } from './loader';
import { parseXmlToolCalls, isNewXmlFormat } from '@/components/thread/tool-views/xml-parser';
import { ShowToolStream } from './ShowToolStream';
import { ComposioUrlDetector } from './composio-url-detector';
import { TaskCompletedFeedback } from '@/components/thread/tool-views/complete-tool/TaskCompletedFeedback';
import { PromptExamples } from '@/components/shared/prompt-examples';

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

// Helper function to extract text content from streaming ask/complete XML (strips all XML tags)
function extractTextFromStreamingAskComplete(content: string, toolName: 'ask' | 'complete'): string {
    if (!content) return '';
    
    // Remove function_calls wrapper if present
    let cleaned = content.replace(/<function_calls[^>]*>/gi, '').replace(/<\/function_calls>/gi, '');
    
    // Try to extract from new format: <invoke name="complete"> <parameter name="text">content</parameter> </invoke>
    const invokeMatch = cleaned.match(new RegExp(`<invoke[^>]*name=["']${toolName}["'][^>]*>([\\s\\S]*?)<\\/invoke>`, 'i'));
    if (invokeMatch) {
        const invokeContent = invokeMatch[1];
        // Extract text parameter
        const textParamMatch = invokeContent.match(/<parameter[^>]*name=["']text["'][^>]*>([\s\S]*?)(?:<\/parameter>|$)/i);
        if (textParamMatch) {
            return textParamMatch[1].trim();
        }
    }
    
    // Try to extract from streaming new format (incomplete tags)
    const streamingInvokeMatch = cleaned.match(new RegExp(`<invoke[^>]*name=["']${toolName}["'][^>]*>([\\s\\S]*)`, 'i'));
    if (streamingInvokeMatch) {
        const invokeContent = streamingInvokeMatch[1];
        // Extract text parameter (might be incomplete)
        const textParamMatch = invokeContent.match(/<parameter[^>]*name=["']text["'][^>]*>([\s\S]*)/i);
        if (textParamMatch) {
            // Remove any remaining XML tags
            return textParamMatch[1]
                .replace(/<\/parameter>[\s\S]*$/i, '')
                .replace(/<\/invoke>[\s\S]*$/i, '')
                .replace(/<\/function_calls>[\s\S]*$/i, '')
                .trim();
        }
    }
    
    // Fallback to old format: <complete>content</complete> or <ask>content</ask>
    const oldFormatMatch = cleaned.match(new RegExp(`<${toolName}[^>]*>([\\s\\S]*?)(?:<\\/${toolName}>|$)`, 'i'));
    if (oldFormatMatch) {
        return oldFormatMatch[1]
            .replace(/<\/parameter>[\s\S]*$/i, '')
            .replace(/<\/invoke>[\s\S]*$/i, '')
            .replace(/<\/function_calls>[\s\S]*$/i, '')
            .trim();
    }
    
    // Last resort: strip all XML tags
    return cleaned
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
}

// Render Markdown content while preserving XML tags that should be displayed as tool calls
export function renderMarkdownContent(
    content: string,
    handleToolClick: (assistantMessageId: string | null, toolName: string) => void,
    messageId: string | null,
    fileViewerHandler?: (filePath?: string, filePathList?: string[]) => void,
    sandboxId?: string,
    project?: Project,
    isLatestMessage?: boolean,
    t?: (key: string) => string,
    threadId?: string,
    onPromptFill?: (message: string) => void
) {
    if (isNewXmlFormat(content)) {
        const contentParts: React.ReactNode[] = [];
        let lastIndex = 0;

        // Find all function_calls blocks
        const functionCallsRegex = /<function_calls>([\s\S]*?)<\/function_calls>/gi;
        let match: RegExpExecArray | null = null;

        while ((match = functionCallsRegex.exec(content)) !== null) {
            // Add text before the function_calls block
            if (match.index > lastIndex) {
                const textBeforeBlock = content.substring(lastIndex, match.index);
                if (textBeforeBlock.trim()) {
                    contentParts.push(
                        <ComposioUrlDetector key={`md-${lastIndex}`} content={textBeforeBlock} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words" />
                    );
                }
            }

            // Parse the tool calls in this block
            const toolCalls = parseXmlToolCalls(match[0]);

            toolCalls.forEach((toolCall, index) => {
                const toolName = toolCall.functionName.replace(/_/g, '-');

                if (toolName === 'ask') {
                    // Handle ask tool specially - extract text, attachments, and follow_up_answers
                    const askText = toolCall.parameters.text || '';
                    const attachments = toolCall.parameters.attachments || [];
                    const followUpAnswers = toolCall.parameters.follow_up_answers || [];

                    // Convert single attachment to array for consistent handling
                    const attachmentArray = Array.isArray(attachments) ? attachments :
                        (typeof attachments === 'string' ? attachments.split(',').map(a => a.trim()) : []);

                    // Parse follow_up_answers if it's a string (JSON array)
                    let followUpAnswersArray: string[] = [];
                    if (followUpAnswers) {
                        if (Array.isArray(followUpAnswers)) {
                            followUpAnswersArray = followUpAnswers.filter((a: string) => a && a.trim().length > 0);
                        } else if (typeof followUpAnswers === 'string') {
                            try {
                                const parsed = JSON.parse(followUpAnswers);
                                if (Array.isArray(parsed)) {
                                    followUpAnswersArray = parsed.filter((a: string) => a && a.trim().length > 0);
                                }
                            } catch (e) {
                                // If parsing fails, ignore
                            }
                        }
                    }

                    // Render ask tool content with attachment UI
                    contentParts.push(
                        <div key={`ask-${match.index}-${index}`} className="space-y-3">
                            <ComposioUrlDetector content={askText} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" />
                            {renderAttachments(attachmentArray, fileViewerHandler, sandboxId, project)}
                            {isLatestMessage && (
                                <div className="flex items-center gap-2">
                                    <Clock className="h-4 w-4 text-orange-500 flex-shrink-0" />
                                    <p className="text-sm text-muted-foreground">
                                        {t ? t('thread.waitingForUserResponse') : 'Kortix will proceed to work autonomously after you answer.'}
                                    </p>
                                </div>
                            )}
                            {/* Follow-up Answers */}
                            {isLatestMessage && PROMPT_SAMPLES_CONFIG.enableAskSamples && followUpAnswersArray.length > 0 && (
                                <PromptExamples
                                    prompts={followUpAnswersArray.slice(0, 4).map(answer => ({ text: answer }))}
                                    onPromptClick={(answer) => {
                                        if (onPromptFill) {
                                            console.log('Filling ChatInput with follow-up answer from ask tool:', answer);
                                            onPromptFill(answer);
                                        } else {
                                            console.log('Follow-up answer clicked (no fill handler):', answer);
                                        }
                                    }}
                                    variant="text"
                                    showTitle={true}
                                    title={t ? t('thread.sampleAnswers') : 'Sample answers'}
                                />
                            )}
                        </div>
                    );
                } else if (toolName === 'complete') {
                    // Handle complete tool specially - extract text, attachments, and follow_up_prompts
                    const completeText = toolCall.parameters.text || '';
                    const attachments = toolCall.parameters.attachments || '';
                    const followUpPrompts = toolCall.parameters.follow_up_prompts || [];

                    // Convert single attachment to array for consistent handling
                    const attachmentArray = Array.isArray(attachments) ? attachments :
                        (typeof attachments === 'string' ? attachments.split(',').map(a => a.trim()) : []);

                    // Parse follow_up_prompts if it's a string (JSON array)
                    let followUpPromptsArray: string[] = [];
                    if (followUpPrompts) {
                        if (Array.isArray(followUpPrompts)) {
                            followUpPromptsArray = followUpPrompts.filter((p: string) => p && p.trim().length > 0);
                        } else if (typeof followUpPrompts === 'string') {
                            try {
                                const parsed = JSON.parse(followUpPrompts);
                                if (Array.isArray(parsed)) {
                                    followUpPromptsArray = parsed.filter((p: string) => p && p.trim().length > 0);
                                }
                            } catch (e) {
                                // If parsing fails, ignore
                            }
                        }
                    }

                    // Render complete tool content with attachment UI
                    contentParts.push(
                        <div key={`complete-${match.index}-${index}`} className="space-y-3">
                            <ComposioUrlDetector content={completeText} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" />
                            {renderAttachments(attachmentArray, fileViewerHandler, sandboxId, project)}
                            <TaskCompletedFeedback
                                taskSummary={completeText}
                                followUpPrompts={isLatestMessage && PROMPT_SAMPLES_CONFIG.enableCompleteSamples && followUpPromptsArray.length > 0 ? followUpPromptsArray : undefined}
                                onFollowUpClick={(prompt) => {
                                    if (onPromptFill) {
                                        console.log('Filling ChatInput with follow-up prompt from complete tool:', prompt);
                                        onPromptFill(prompt);
                                    } else {
                                        console.log('Follow-up clicked (no fill handler):', prompt);
                                    }
                                }}
                                samplePromptsTitle={t ? t('thread.samplePrompts') : 'Sample prompts'}
                                threadId={threadId}
                                messageId={messageId}
                            />
                        </div>
                    );
                } else {
                    const IconComponent = getToolIcon(toolName);

                    // Extract primary parameter for display
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

                    contentParts.push(
                        <div
                            key={`tool-${match.index}-${index}`}
                            className="my-1"
                        >
                            <button
                                onClick={() => handleToolClick(messageId, toolName)}
                                className="inline-flex items-center gap-1.5 py-1 px-1 pr-1.5 text-xs text-muted-foreground bg-muted hover:bg-muted/80 rounded-lg transition-colors cursor-pointer border border-neutral-200 dark:border-neutral-700/50"
                            >
                                <div className='border-2 bg-gradient-to-br from-neutral-200 to-neutral-300 dark:from-neutral-700 dark:to-neutral-800 flex items-center justify-center p-0.5 rounded-sm border-neutral-400/20 dark:border-neutral-600'>
                                    <IconComponent className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                                </div>
                                <span className="font-mono text-xs text-foreground">{getUserFriendlyToolName(toolName)}</span>
                                {paramDisplay && <span className="ml-1 text-xs text-muted-foreground truncate max-w-[200px]" title={paramDisplay}>{paramDisplay}</span>}
                            </button>
                        </div>
                    );
                }
            });

            lastIndex = match.index + match[0].length;
        }

        // Add any remaining text after the last function_calls block
        if (lastIndex < content.length) {
            const remainingText = content.substring(lastIndex);
            if (remainingText.trim()) {
                contentParts.push(
                    <ComposioUrlDetector key={`md-${lastIndex}`} content={remainingText} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words" />
                );
            }
        }

        return contentParts.length > 0 ? contentParts : <ComposioUrlDetector content={content} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words" />;
    }

    // Fall back to old XML format handling
    const xmlRegex = /<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?>(?:[\s\S]*?)<\/\1>|<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?\/>/g;
    let lastIndex = 0;
    const contentParts: React.ReactNode[] = [];
    let match: RegExpExecArray | null = null;

    // If no XML tags found, just return the full content as markdown
    if (!content.match(xmlRegex)) {
        return <ComposioUrlDetector content={content} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words" />;
    }

    while ((match = xmlRegex.exec(content)) !== null) {
        // Add text before the tag as markdown
        if (match.index > lastIndex) {
            const textBeforeTag = content.substring(lastIndex, match.index);
            contentParts.push(
                <ComposioUrlDetector key={`md-${lastIndex}`} content={textBeforeTag} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none inline-block mr-1 break-words" />
            );
        }

        const rawXml = match[0];
        const toolName = match[1] || match[2];
        const toolCallKey = `tool-${match.index}`;

        if (toolName === 'ask') {
            // Extract attachments from the XML attributes
            const attachmentsMatch = rawXml.match(/attachments=["']([^"']*)["']/i);
            const attachments = attachmentsMatch
                ? attachmentsMatch[1].split(',').map(a => a.trim())
                : [];

            // Extract content from the ask tag
            const contentMatch = rawXml.match(/<ask[^>]*>([\s\S]*?)<\/ask>/i);
            const askContent = contentMatch ? contentMatch[1] : '';

            // Render <ask> tag content with attachment UI (using the helper)
            // Note: Legacy format doesn't support follow_up_answers, so we only show the waiting message
            contentParts.push(
                <div key={`ask-${match.index}`} className="space-y-3">
                    <ComposioUrlDetector content={askContent} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" />
                    {renderAttachments(attachments, fileViewerHandler, sandboxId, project)}
                    {isLatestMessage && (
                        <div className="flex items-center gap-2">
                            <Clock className="h-4 w-4 text-orange-500 flex-shrink-0" />
                            <p className="text-sm text-muted-foreground">
                                {t ? t('thread.waitingForUserResponse') : 'Kortix will proceed to work autonomously after you answer.'}
                            </p>
                        </div>
                    )}
                </div>
            );
        } else if (toolName === 'complete') {
            // Extract attachments from the XML attributes
            const attachmentsMatch = rawXml.match(/attachments=["']([^"']*)["']/i);
            const attachments = attachmentsMatch
                ? attachmentsMatch[1].split(',').map(a => a.trim())
                : [];

            // Extract content from the complete tag
            const contentMatch = rawXml.match(/<complete[^>]*>([\s\S]*?)<\/complete>/i);
            const completeContent = contentMatch ? contentMatch[1] : '';

            // Render <complete> tag content with attachment UI (using the helper)
            contentParts.push(
                <div key={`complete-${match.index}`} className="space-y-3">
                    <ComposioUrlDetector content={completeContent} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" />
                    {renderAttachments(attachments, fileViewerHandler, sandboxId, project)}
                </div>
            );
        } else {
            const IconComponent = getToolIcon(toolName);
            const paramDisplay = extractPrimaryParam(toolName, rawXml);

            // Render tool button as a clickable element
            contentParts.push(
                <div
                    key={toolCallKey}
                    className="my-1"
                >
                    <button
                        onClick={() => handleToolClick(messageId, toolName)}
                        className="inline-flex items-center gap-1.5 py-1 px-1 pr-1.5 text-xs text-muted-foreground bg-muted hover:bg-muted/80 rounded-lg transition-colors cursor-pointer border border-neutral-200 dark:border-neutral-700/50"
                    >
                        <div className='border-2 bg-gradient-to-br from-neutral-200 to-neutral-300 dark:from-neutral-700 dark:to-neutral-800 flex items-center justify-center p-0.5 rounded-sm border-neutral-400/20 dark:border-neutral-600'>
                            <IconComponent className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        </div>
                        <span className="font-mono text-xs text-foreground">{getUserFriendlyToolName(toolName)}</span>
                        {paramDisplay && <span className="ml-1 text-xs text-muted-foreground truncate max-w-[200px]" title={paramDisplay}>{paramDisplay}</span>}
                    </button>
                </div>
            );
        }
        lastIndex = xmlRegex.lastIndex;
    }

    // Add text after the last tag
    if (lastIndex < content.length) {
        contentParts.push(
            <ComposioUrlDetector key={`md-${lastIndex}`} content={content.substring(lastIndex)} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words" />
        );
    }

    return contentParts;
}

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
                                                                        const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
                                                                        const msgKey = message.message_id || `submsg-assistant-${msgIndex}`;

                                                                        if (!parsedContent.content) return;

                                                                        // Check if this is the latest message (last assistant message in the last group)
                                                                        const isLatestMessage = isLastGroup && message.message_id === lastAssistantMessageId;

                                                                        const renderedContent = renderMarkdownContent(
                                                                            parsedContent.content,
                                                                            handleToolClick,
                                                                            message.message_id,
                                                                            handleOpenFileViewer,
                                                                            sandboxId,
                                                                            project,
                                                                            isLatestMessage,
                                                                            t,
                                                                            threadId,
                                                                            onPromptFill
                                                                        );

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

                                                            {groupIndex === finalGroupedMessages.length - 1 && !readOnly && (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') && (
                                                                <div className="mt-2">
                                                                    {(() => {
                                                                        let detectedTag: string | null = null;
                                                                        let tagStartIndex = -1;
                                                                        if (streamingTextContent) {
                                                                            // First check for ask/complete tags directly (they should render as markdown)
                                                                            const askIndex = streamingTextContent.indexOf('<ask');
                                                                            const completeIndex = streamingTextContent.indexOf('<complete');
                                                                            if (askIndex !== -1 && (completeIndex === -1 || askIndex < completeIndex)) {
                                                                                detectedTag = 'ask';
                                                                                tagStartIndex = askIndex;
                                                                            } else if (completeIndex !== -1) {
                                                                                detectedTag = 'complete';
                                                                                tagStartIndex = completeIndex;
                                                                            } else {
                                                                                // Check for new format function_calls
                                                                                const functionCallsIndex = streamingTextContent.indexOf('<function_calls>');
                                                                                if (functionCallsIndex !== -1) {
                                                                                    // Check if function_calls contains ask or complete
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
                                                                                    // Fall back to old format detection
                                                                                    for (const tag of HIDE_STREAMING_XML_TAGS) {
                                                                                        if (tag === 'ask' || tag === 'complete') continue; // Already handled above
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
                                                                        }


                                                                        const textToRender = streamingTextContent || '';
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
