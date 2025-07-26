import React, { useRef, useState, useCallback } from 'react';
import { ArrowDown, CircleDashed, CheckCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/ui/markdown';
import { UnifiedMessage, ParsedContent, ParsedMetadata } from '@/components/thread/types';
import { FileAttachmentGrid } from '@/components/thread/file-attachment';
import { useFilePreloader, FileCache } from '@/hooks/react-query/files';
import { useAuth } from '@/components/AuthProvider';
import { Project } from '@/lib/api';
import {
    extractPrimaryParam,
    getToolIcon,
    getUserFriendlyToolName,
    safeJsonParse,
} from '@/components/thread/utils';
import { formatMCPToolDisplayName } from '@/components/thread/tool-views/mcp-tool/_utils';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { AgentLoader } from './loader';
import { parseXmlToolCalls, isNewXmlFormat, extractToolNameFromStream } from '@/components/thread/tool-views/xml-parser';
import { parseToolResult } from '@/components/thread/tool-views/tool-result-parser';
import { ShowToolStream } from './ShowToolStream';
import { PipedreamConnectButton } from './pipedream-connect-button';
import { PipedreamUrlDetector } from './pipedream-url-detector';

const HIDE_STREAMING_XML_TAGS = new Set([
    'execute-command',
    'create-file',
    'delete-file',
    'full-file-rewrite',
    'edit-file',
    'str-replace',
    'browser-click-element',
    'browser-close-tab',
    'browser-drag-drop',
    'browser-get-dropdown-options',
    'browser-go-back',
    'browser-input-text',
    'browser-navigate-to',
    'browser-scroll-down',
    'browser-scroll-to-text',
    'browser-scroll-up',
    'browser-select-dropdown-option',
    'browser-send-keys',
    'browser-switch-tab',
    'browser-wait',
    'deploy',
    'ask',
    'complete',
    'crawl-webpage',
    'web-search',
    'see-image',
    'call-mcp-tool',

    'execute_data_provider_call',
    'execute_data_provider_endpoint',

    'execute-data-provider-call',
    'execute-data-provider-endpoint',
]);

function getEnhancedToolDisplayName(toolName: string, rawXml?: string): string {
    if (toolName === 'call-mcp-tool' && rawXml) {
        const toolNameMatch = rawXml.match(/tool_name="([^"]+)"/);
        if (toolNameMatch) {
            const fullToolName = toolNameMatch[1];
            const parts = fullToolName.split('_');
            if (parts.length >= 3 && fullToolName.startsWith('mcp_')) {
                const serverName = parts[1];
                const toolNamePart = parts.slice(2).join('_');
                return formatMCPToolDisplayName(serverName, toolNamePart);
            }
        }
    }
    return getUserFriendlyToolName(toolName);
}

// Helper function to render attachments (keeping original implementation for now)
export function renderAttachments(attachments: string[], fileViewerHandler?: (filePath?: string, filePathList?: string[]) => void, sandboxId?: string, project?: Project) {
    if (!attachments || attachments.length === 0) return null;

    // Note: Preloading is now handled by React Query in the main ThreadContent component
    // to avoid duplicate requests with different content types

    return <FileAttachmentGrid
        attachments={attachments}
        onFileClick={fileViewerHandler}
        showPreviews={true}
        sandboxId={sandboxId}
        project={project}
    />;
}

// Render Markdown content while preserving XML tags that should be displayed as tool calls
export function renderMarkdownContent(
    content: string,
    handleToolClick: (assistantMessageId: string | null, toolName: string) => void,
    messageId: string | null,
    fileViewerHandler?: (filePath?: string, filePathList?: string[]) => void,
    sandboxId?: string,
    project?: Project,
    debugMode?: boolean
) {
    // If in debug mode, just display raw content in a pre tag
    if (debugMode) {
        return (
            <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto p-2 border border-border rounded-md bg-muted/30 text-foreground">
                {content}
            </pre>
        );
    }

    // Check if content contains the new Cursor-style format
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
                        <PipedreamUrlDetector key={`md-${lastIndex}`} content={textBeforeBlock} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words" />
                    );
                }
            }

            // Parse the tool calls in this block
            const toolCalls = parseXmlToolCalls(match[0]);

            toolCalls.forEach((toolCall, index) => {
                const toolName = toolCall.functionName.replace(/_/g, '-');

                if (toolName === 'ask') {
                    // Handle ask tool specially - extract text and attachments
                    const askText = toolCall.parameters.text || '';
                    const attachments = toolCall.parameters.attachments || [];

                    // Convert single attachment to array for consistent handling
                    const attachmentArray = Array.isArray(attachments) ? attachments :
                        (typeof attachments === 'string' ? attachments.split(',').map(a => a.trim()) : []);

                    // Render ask tool content with attachment UI
                    contentParts.push(
                        <div key={`ask-${match.index}-${index}`} className="space-y-3">
                            <PipedreamUrlDetector content={askText} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" />
                            {renderAttachments(attachmentArray, fileViewerHandler, sandboxId, project)}
                        </div>
                    );
                } else if (toolName === 'complete') {
                    // Handle complete tool specially - extract text and attachments
                    const completeText = toolCall.parameters.text || '';
                    const attachments = toolCall.parameters.attachments || '';

                    // Convert single attachment to array for consistent handling
                    const attachmentArray = Array.isArray(attachments) ? attachments :
                        (typeof attachments === 'string' ? attachments.split(',').map(a => a.trim()) : []);

                    // Render complete tool content with attachment UI
                    contentParts.push(
                        <div key={`complete-${match.index}-${index}`} className="space-y-3">
                            <PipedreamUrlDetector content={completeText} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" />
                            {renderAttachments(attachmentArray, fileViewerHandler, sandboxId, project)}
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
                                {paramDisplay && <span className="ml-1 text-muted-foreground truncate max-w-[200px]" title={paramDisplay}>{paramDisplay}</span>}
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
                    <PipedreamUrlDetector key={`md-${lastIndex}`} content={remainingText} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words" />
                );
            }
        }

        return contentParts.length > 0 ? contentParts : <PipedreamUrlDetector content={content} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words" />;
    }

    // Fall back to old XML format handling
    const xmlRegex = /<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?>(?:[\s\S]*?)<\/\1>|<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?\/>/g;
    let lastIndex = 0;
    const contentParts: React.ReactNode[] = [];
    let match: RegExpExecArray | null = null;

    // If no XML tags found, just return the full content as markdown
    if (!content.match(xmlRegex)) {
        return <PipedreamUrlDetector content={content} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words" />;
    }

    while ((match = xmlRegex.exec(content)) !== null) {
        // Add text before the tag as markdown
        if (match.index > lastIndex) {
            const textBeforeTag = content.substring(lastIndex, match.index);
            contentParts.push(
                <PipedreamUrlDetector key={`md-${lastIndex}`} content={textBeforeTag} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none inline-block mr-1 break-words" />
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
            contentParts.push(
                <div key={`ask-${match.index}`} className="space-y-3">
                    <PipedreamUrlDetector content={askContent} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" />
                    {renderAttachments(attachments, fileViewerHandler, sandboxId, project)}
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
                    <PipedreamUrlDetector content={completeContent} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3" />
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
                        {paramDisplay && <span className="ml-1 text-muted-foreground truncate max-w-[200px]" title={paramDisplay}>{paramDisplay}</span>}
                    </button>
                </div>
            );
        }
        lastIndex = xmlRegex.lastIndex;
    }

    // Add text after the last tag
    if (lastIndex < content.length) {
        contentParts.push(
            <PipedreamUrlDetector key={`md-${lastIndex}`} content={content.substring(lastIndex)} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words" />
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
    debugMode?: boolean; // Add debug mode parameter
    isPreviewMode?: boolean;
    agentName?: string;
    agentAvatar?: React.ReactNode;
    emptyStateComponent?: React.ReactNode; // Add custom empty state component prop
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
    debugMode = false,
    isPreviewMode = false,
    agentName = 'Suna',
    agentAvatar = <KortixLogo size={16} />,
    emptyStateComponent,
}) => {
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestMessageRef = useRef<HTMLDivElement>(null);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const [, setUserHasScrolled] = useState(false);
    const { session } = useAuth();

    // React Query file preloader
    const { preloadFiles } = useFilePreloader();

    const containerClassName = isPreviewMode
        ? "flex-1 overflow-y-auto scrollbar-thin scrollbar-track-secondary/0 scrollbar-thumb-primary/10 scrollbar-thumb-rounded-full hover:scrollbar-thumb-primary/10 px-6 py-4 pb-72"
        : "flex-1 overflow-y-auto scrollbar-thin scrollbar-track-secondary/0 scrollbar-thumb-primary/10 scrollbar-thumb-rounded-full hover:scrollbar-thumb-primary/10 px-6 py-4 pb-72 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60";

    // In playback mode, we use visibleMessages instead of messages
    const displayMessages = readOnly && visibleMessages ? visibleMessages : messages;

    const handleScroll = () => {
        if (!messagesContainerRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
        const isScrolledUp = scrollHeight - scrollTop - clientHeight > 100;
        setShowScrollButton(isScrolledUp);
        setUserHasScrolled(isScrolledUp);
    };

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
        messagesEndRef.current?.scrollIntoView({ behavior });
    }, []);

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
                // Render scrollable content container
                <div
                    ref={messagesContainerRef}
                    className={containerClassName}
                    onScroll={handleScroll}
                >
                    <div className="mx-auto max-w-3xl md:px-8 min-w-0">
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

                                // Handle streaming content - only add to existing group or create new one if needed
                                if (streamingTextContent) {
                                    const lastGroup = finalGroupedMessages.at(-1);
                                    if (!lastGroup || lastGroup.type === 'user') {
                                        // Create new assistant group for streaming content
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
                                        // Only add streaming content if it's not already represented in the last message
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

                                        // In debug mode, display raw message content
                                        if (debugMode) {
                                            return (
                                                <div key={group.key} className="flex justify-end">
                                                    <div className="flex max-w-[85%] rounded-2xl bg-card px-4 py-3 break-words overflow-hidden">
                                                        <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto min-w-0 flex-1">
                                                            {message.content}
                                                        </pre>
                                                    </div>
                                                </div>
                                            );
                                        }

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
                                            <PipedreamUrlDetector content={cleanContent} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3 break-words overflow-wrap-anywhere" />
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
                                                            {(() => {
                                                                const firstAssistantWithAgent = group.messages.find(msg =>
                                                                    msg.type === 'assistant' && (msg.agents?.avatar || msg.agents?.avatar_color)
                                                                );

                                                                const isSunaAgent = firstAssistantWithAgent?.agents?.name === 'Suna';

                                                                if (firstAssistantWithAgent?.agents?.avatar) {
                                                                    const avatar = firstAssistantWithAgent.agents.avatar;
                                                                    return (
                                                                        <>
                                                                            {isSunaAgent ? (
                                                                                <div className="h-5 w-5 flex items-center justify-center rounded text-xs">
                                                                                    <KortixLogo size={16} />
                                                                                </div>
                                                                            ) : (
                                                                                <div
                                                                                    className="h-5 w-5 flex items-center justify-center rounded text-xs"
                                                                                >
                                                                                    <span className="text-lg">{avatar}</span>
                                                                                </div>
                                                                            )}
                                                                        </>
                                                                    );
                                                                }
                                                                return <KortixLogo size={16} />;
                                                            })()}
                                                        </div>
                                                        <p className='ml-2 text-sm text-muted-foreground'>
                                                            {(() => {
                                                                const firstAssistantWithAgent = group.messages.find(msg =>
                                                                    msg.type === 'assistant' && msg.agents?.name
                                                                );
                                                                if (firstAssistantWithAgent?.agents?.name) {
                                                                    return firstAssistantWithAgent.agents.name;
                                                                }
                                                                return 'Suna';
                                                            })()}
                                                        </p>
                                                    </div>

                                                    {/* Message content - ALL messages in the group */}
                                                    <div className="flex max-w-[90%] text-sm break-words overflow-hidden">
                                                        <div className="space-y-2 min-w-0 flex-1">
                                                            {(() => {
                                                                // In debug mode, just show raw messages content
                                                                if (debugMode) {
                                                                    return group.messages.map((message, msgIndex) => {
                                                                        const msgKey = message.message_id || `raw-msg-${msgIndex}`;
                                                                        return (
                                                                            <div key={msgKey} className="mb-4">
                                                                                <div className="text-xs font-medium text-muted-foreground mb-1">
                                                                                    Type: {message.type} | ID: {message.message_id || 'no-id'}
                                                                                </div>
                                                                                <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto p-2 border border-border rounded-md bg-muted/30">
                                                                                    {JSON.stringify(message.content, null, 2)}
                                                                                </pre>
                                                                                {message.metadata && message.metadata !== '{}' && (
                                                                                    <div className="mt-2">
                                                                                        <div className="text-xs font-medium text-muted-foreground mb-1">
                                                                                            Metadata:
                                                                                        </div>
                                                                                        <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto p-2 border border-border rounded-md bg-muted/30">
                                                                                            {JSON.stringify(message.metadata, null, 2)}
                                                                                        </pre>
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        );
                                                                    });
                                                                }

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

                                                                group.messages.forEach((message, msgIndex) => {
                                                                    if (message.type === 'assistant') {
                                                                        const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
                                                                        const msgKey = message.message_id || `submsg-assistant-${msgIndex}`;

                                                                        if (!parsedContent.content) return;

                                                                        const renderedContent = renderMarkdownContent(
                                                                            parsedContent.content,
                                                                            handleToolClick,
                                                                            message.message_id,
                                                                            handleOpenFileViewer,
                                                                            sandboxId,
                                                                            project,
                                                                            debugMode
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
                                                                        // In debug mode, show raw streaming content
                                                                        if (debugMode && streamingTextContent) {
                                                                            return (
                                                                                <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto p-2 border border-border rounded-md bg-muted/30">
                                                                                    {streamingTextContent}
                                                                                </pre>
                                                                            );
                                                                        }

                                                                        let detectedTag: string | null = null;
                                                                        let tagStartIndex = -1;
                                                                        if (streamingTextContent) {
                                                                            // First check for new format
                                                                            const functionCallsIndex = streamingTextContent.indexOf('<function_calls>');
                                                                            if (functionCallsIndex !== -1) {
                                                                                detectedTag = 'function_calls';
                                                                                tagStartIndex = functionCallsIndex;
                                                                            } else {
                                                                                // Fall back to old format detection
                                                                                for (const tag of HIDE_STREAMING_XML_TAGS) {
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


                                                                        const textToRender = streamingTextContent || '';
                                                                        const textBeforeTag = detectedTag ? textToRender.substring(0, tagStartIndex) : textToRender;
                                                                        const showCursor = (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') && !detectedTag;

                                                                        return (
                                                                            <>
                                                                                {textBeforeTag && (
                                                                                    <PipedreamUrlDetector content={textBeforeTag} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3 break-words overflow-wrap-anywhere" />
                                                                                )}
                                                                                {showCursor && (
                                                                                    <span className="inline-block h-4 w-0.5 bg-primary ml-0.5 -mb-1 animate-pulse" />
                                                                                )}

                                                                                {detectedTag && (
                                                                                    <ShowToolStream
                                                                                        content={textToRender.substring(tagStartIndex)}
                                                                                        messageId={visibleMessages && visibleMessages.length > 0 ? visibleMessages[visibleMessages.length - 1].message_id : "playback-streaming"}
                                                                                        onToolClick={handleToolClick}
                                                                                        showExpanded={true}
                                                                                        startTime={Date.now()}
                                                                                    />
                                                                                )}


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
                                                                            // First check for new format
                                                                            const functionCallsIndex = streamingText.indexOf('<function_calls>');
                                                                            if (functionCallsIndex !== -1) {
                                                                                detectedTag = 'function_calls';
                                                                                tagStartIndex = functionCallsIndex;
                                                                            } else {
                                                                                // Fall back to old format detection
                                                                                for (const tag of HIDE_STREAMING_XML_TAGS) {
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

                                                                        const textToRender = streamingText || '';
                                                                        const textBeforeTag = detectedTag ? textToRender.substring(0, tagStartIndex) : textToRender;
                                                                        const showCursor = isStreamingText && !detectedTag;

                                                                        return (
                                                                            <>
                                                                                {/* In debug mode, show raw streaming content */}
                                                                                {debugMode && streamingText ? (
                                                                                    <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto p-2 border border-border rounded-md bg-muted/30">
                                                                                        {streamingText}
                                                                                    </pre>
                                                                                ) : (
                                                                                    <>
                                                                                        {textBeforeTag && (
                                                                                            <PipedreamUrlDetector content={textBeforeTag} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3 break-words overflow-wrap-anywhere" />
                                                                                        )}
                                                                                        {showCursor && (
                                                                                            <span className="inline-block h-4 w-0.5 bg-primary ml-0.5 -mb-1 animate-pulse" />
                                                                                        )}

                                                                                        {detectedTag && (
                                                                                            <ShowToolStream
                                                                                                content={textToRender.substring(tagStartIndex)}
                                                                                                messageId="streamingTextContent"
                                                                                                onToolClick={handleToolClick}
                                                                                                showExpanded={true}
                                                                                                startTime={Date.now()} // Tool just started now
                                                                                            />
                                                                                        )}
                                                                                    </>
                                                                                )}
                                                                            </>
                                                                        );
                                                                    })()}
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
                            {((agentStatus === 'running' || agentStatus === 'connecting') && !streamingTextContent &&
                                !readOnly &&
                                (messages.length === 0 || messages[messages.length - 1].type === 'user')) && (
                                    <div ref={latestMessageRef} className='w-full h-22 rounded'>
                                        <div className="flex flex-col gap-2">
                                            {/* Logo positioned above the loader */}
                                            <div className="flex items-center">
                                                <div className="rounded-md flex items-center justify-center">
                                                    {agentAvatar}
                                                </div>
                                                <p className='ml-2 text-sm text-muted-foreground'>{agentName || 'Suna'}</p>
                                            </div>

                                            {/* Loader content */}
                                            <div className="space-y-2 w-full h-12">
                                                <AgentLoader />
                                            </div>
                                        </div>
                                    </div>
                                )}

                            {/* For playback mode - Show tool call animation if active */}
                            {readOnly && currentToolCall && (
                                <div ref={latestMessageRef}>
                                    <div className="flex flex-col gap-2">
                                        {/* Logo positioned above the tool call */}
                                        <div className="flex justify-start">
                                            <div className="rounded-md flex items-center justify-center">
                                                {agentAvatar}
                                            </div>
                                            <p className='ml-2 text-sm text-muted-foreground'>{agentName || 'Suna'}</p>
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
                                                {agentAvatar}
                                            </div>
                                            <p className='ml-2 text-sm text-muted-foreground'>{agentName || 'Suna'}</p>
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
                        </div>
                    </div>
                    <div ref={messagesEndRef} className="h-1" />
                </div>
            )}

            {/* Scroll to bottom button */}
            {showScrollButton && (
                <Button
                    variant="outline"
                    size="icon"
                    className="fixed bottom-20 right-6 z-10 h-8 w-8 rounded-full shadow-md"
                    onClick={() => scrollToBottom('smooth')}
                >
                    <ArrowDown className="h-4 w-4" />
                </Button>
            )}
        </>
    );
};

export default ThreadContent; 
