import React, { useEffect, useRef, useState } from 'react';
import { CircleDashed } from 'lucide-react';
import { getToolIcon, getUserFriendlyToolName, extractPrimaryParam } from '@/components/thread/utils';
import { CodeBlockCode } from '@/components/ui/code-block';
import { getLanguageFromFileName } from '../tool-views/file-operation/_utils';

// Define tool categories for different streaming behaviors
const STREAMABLE_TOOLS = {
    // File operation tools - show full content streaming
    FILE_OPERATIONS: new Set([
        'Creating File',
        'Rewriting File',
        'AI File Edit',
        'Editing Text',
        'Editing File',
        'Deleting File',
    ]),

    // Command tools - show command output streaming
    COMMAND_TOOLS: new Set([
        'Executing Command',
        'Checking Command Output',
        'Terminating Command',
        'Listing Commands',
    ]),

    // Browser tools - show action details streaming
    BROWSER_TOOLS: new Set([
        'Navigating to Page',
        'Performing Action',
        'Extracting Content',
        'Taking Screenshot',
    ]),

    // Web tools - show search/crawl results streaming
    WEB_TOOLS: new Set([
        'Searching Web',
        'Crawling Website',
        'Scraping Website',
    ]),

    // Other tools that benefit from content streaming
    OTHER_STREAMABLE: new Set([
        'Calling data provider',
        'Getting endpoints',
        'Creating Tasks',
        'Updating Tasks',
        'Viewing Image',
        'Creating Presentation Outline',
        'Creating Presentation',
        'Exposing Port',
        'Getting Agent Config',
        'Searching MCP Servers',
        'Creating Credential Profile',
        'Connecting Credential Profile',
        'Checking Profile Connection',
        'Configuring Profile For Agent',
        'Getting Credential Profiles',
    ])
};

// Check if a tool should show streaming content
const isStreamableTool = (toolName: string) => {
    return Object.values(STREAMABLE_TOOLS).some(toolSet => toolSet.has(toolName));
};

interface ShowToolStreamProps {
    content: string;
    messageId?: string | null;
    onToolClick?: (messageId: string | null, toolName: string) => void;
    showExpanded?: boolean; // Whether to show expanded streaming view
    startTime?: number; // When the tool started running
}

export const ShowToolStream: React.FC<ShowToolStreamProps> = ({
    content,
    messageId,
    onToolClick,
    showExpanded = false,
    startTime
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [shouldShowContent, setShouldShowContent] = useState(false);
    const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
    // Use ref to store stable start time - only set once!
    const stableStartTimeRef = useRef<number | null>(null);

    // Set stable start time only once
    if (showExpanded && !stableStartTimeRef.current) {
        stableStartTimeRef.current = Date.now();
    }

    // Extract tool name from content - try JSON first, then fallback to simple extraction
    let rawToolName: string | null = null;
    try {
      const parsed = JSON.parse(content);
      if (parsed.function?.name) {
        rawToolName = parsed.function.name;
      } else if (parsed.tool_name) {
        rawToolName = parsed.tool_name;
      }
    } catch (e) {
      // Not JSON, try simple regex extraction
      const match = content.match(/(?:function|tool)[_\-]?name["']?\s*[:=]\s*["']?([^"'\s]+)/i);
      if (match) {
        rawToolName = match[1];
      }
    }
    const toolName = getUserFriendlyToolName(rawToolName || '');
    const isEditFile = toolName === 'AI File Edit';
    const isCreateFile = toolName === 'Creating File';
    const isFullFileRewrite = toolName === 'Rewriting File';

    // Extract content from JSON or plain text
    const extractContent = (rawContent: string): { html: string; plainText: string } => {
        if (!rawContent || typeof rawContent !== 'string') return { html: '', plainText: '' };

        try {
            // Try to parse as JSON first
            const parsed = JSON.parse(rawContent);
            if (parsed.content) {
                return { html: parsed.content, plainText: parsed.content };
            }
            if (parsed.arguments) {
                const argsStr = typeof parsed.arguments === 'string' 
                    ? parsed.arguments 
                    : JSON.stringify(parsed.arguments);
                return { html: argsStr, plainText: argsStr };
            }
        } catch (e) {
            // Not JSON, return as-is
        }

        return { html: rawContent, plainText: rawContent };
    };

    // Extract streaming content from JSON or plain text
    const streamingContent = React.useMemo(() => {
        if (!content) return { html: '', plainText: '' };

        try {
            // Try to parse as JSON first
            const parsed = JSON.parse(content);
            
            // For file operations, extract file_contents or code_edit
            if (STREAMABLE_TOOLS.FILE_OPERATIONS.has(toolName || '')) {
                if (isEditFile && parsed.code_edit) {
                    return { html: parsed.code_edit, plainText: parsed.code_edit };
                }
                if ((isCreateFile || isFullFileRewrite) && parsed.file_contents) {
                    return { html: parsed.file_contents, plainText: parsed.file_contents };
                }
                if (parsed.arguments) {
                    const args = typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : parsed.arguments;
                    if (isEditFile && args.code_edit) {
                        return { html: args.code_edit, plainText: args.code_edit };
                    }
                    if ((isCreateFile || isFullFileRewrite) && args.file_contents) {
                        return { html: args.file_contents, plainText: args.file_contents };
                    }
                }
            }

            // Command tools - extract command
            if (STREAMABLE_TOOLS.COMMAND_TOOLS.has(toolName || '')) {
                if (parsed.command) {
                    return { html: `<strong>command:</strong> ${parsed.command}`, plainText: `command: ${parsed.command}` };
                }
                if (parsed.arguments?.command) {
                    return { html: `<strong>command:</strong> ${parsed.arguments.command}`, plainText: `command: ${parsed.arguments.command}` };
                }
            }

            // Browser tools
            if (STREAMABLE_TOOLS.BROWSER_TOOLS.has(toolName || '')) {
                if (parsed.url) {
                    return { html: `<strong>url:</strong> ${parsed.url}`, plainText: `url: ${parsed.url}` };
                }
                if (parsed.action) {
                    return { html: `<strong>action:</strong> ${parsed.action}`, plainText: `action: ${parsed.action}` };
                }
                if (parsed.instruction) {
                    return { html: `<strong>instruction:</strong> ${parsed.instruction}`, plainText: `instruction: ${parsed.instruction}` };
                }
            }

            // Web tools
            if (STREAMABLE_TOOLS.WEB_TOOLS.has(toolName || '')) {
                if (parsed.query) {
                    return { html: `<strong>query:</strong> ${parsed.query}`, plainText: `query: ${parsed.query}` };
                }
                if (parsed.url) {
                    return { html: `<strong>url:</strong> ${parsed.url}`, plainText: `url: ${parsed.url}` };
                }
            }

            // Fallback: return content or arguments as string
            if (parsed.content) {
                return { html: parsed.content, plainText: parsed.content };
            }
            if (parsed.arguments) {
                const argsStr = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments);
                return { html: argsStr, plainText: argsStr };
            }
        } catch (e) {
            // Not JSON, return as-is
        }

        // Fallback: return content as-is
        return { html: content, plainText: content };
    }, [content, toolName, isEditFile, isCreateFile, isFullFileRewrite]);

    // Show streaming content for all streamable tools with delayed transitions
    useEffect(() => {
        if (showExpanded && isStreamableTool(toolName || '')) {
            // Small delay to allow for smooth opening
            const timer = setTimeout(() => setShouldShowContent(true), 50);
            return () => clearTimeout(timer);
        } else {
            // Immediate close but with smooth animation
            setShouldShowContent(false);
        }
    }, [showExpanded, toolName]);

    useEffect(() => {
        if (containerRef.current && shouldShowContent && shouldAutoScroll) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [content, shouldShowContent, shouldAutoScroll]);

    // Handle scroll events to disable auto-scroll when user scrolls up
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = container;
            const isAtBottom = scrollTop + clientHeight >= scrollHeight - 5;
            setShouldAutoScroll(isAtBottom);
        };

        container.addEventListener('scroll', handleScroll);
        return () => container.removeEventListener('scroll', handleScroll);
    }, [shouldShowContent]);

    if (!toolName) {
        return null;
    }

    // Check if this is a streamable tool
    const isToolStreamable = isStreamableTool(toolName);

    const IconComponent = getToolIcon(rawToolName || '');
    const displayName = toolName;
    const paramDisplay = extractPrimaryParam(rawToolName || '', content);

    // Always show tool button, conditionally show content below for streamable tools
    if (showExpanded && isToolStreamable) {
        return (
            <div className="my-1">
                {/* Always render the container for smooth transitions */}
                <div className={`border border-neutral-200 dark:border-neutral-700/50 rounded-2xl overflow-hidden transition-all duration-500 ease-in-out transform-gpu ${shouldShowContent ? 'bg-zinc-100 dark:bg-neutral-900' : 'bg-muted scale-95 opacity-80'
                    }`}>
                    {/* Tool name header */}
                    <button
                        onClick={() => onToolClick?.(messageId, toolName)}
                        className={`w-full flex items-center gap-1.5 py-1 px-2 text-xs text-muted-foreground hover:bg-muted/80 transition-all duration-400 ease-in-out cursor-pointer ${shouldShowContent ? 'bg-muted' : 'bg-muted rounded-2xl'
                            }`}
                    >
                        <div className=' flex items-center justify-center p-1 rounded-sm'>
                            <CircleDashed className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 animate-spin animation-duration-2000" />
                        </div>
                        <span className="font-mono text-xs text-foreground">{displayName}</span>
                        {paramDisplay && <span className="ml-1 text-xs text-muted-foreground truncate max-w-[200px]" title={paramDisplay}>{paramDisplay}</span>}
                    </button>

                    {/* Streaming content below - smooth height transition */}
                    <div className={`transition-all duration-500 ease-in-out overflow-hidden transform-gpu ${shouldShowContent ? 'max-h-[350px] border-t border-neutral-200 dark:border-neutral-700/50 opacity-100' : 'max-h-0 border-t-0 opacity-0 scale-y-95'
                        }`}>
                        <div className="relative">
                            <div
                                ref={containerRef}
                                className={`max-h-[300px] overflow-y-auto scrollbar-none text-xs text-foreground transition-all duration-400 ease-in-out transform-gpu ${STREAMABLE_TOOLS.FILE_OPERATIONS.has(toolName || '') || STREAMABLE_TOOLS.COMMAND_TOOLS.has(toolName || '')
                                    ? 'font-mono whitespace-pre-wrap'
                                    : 'whitespace-pre-wrap'
                                    } ${shouldShowContent ? 'opacity-100 translate-y-0 p-3' : 'opacity-0 translate-y-3 scale-95 p-0'}`}
                                style={{
                                    maskImage: shouldShowContent ? 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)' : 'none',
                                    WebkitMaskImage: shouldShowContent ? 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)' : 'none'
                                }}
                            >
                                {(() => {
                                    // Get the content to display
                                    const contentToDisplay = typeof streamingContent === 'string' ? streamingContent : streamingContent.plainText;
                                    const htmlContent = typeof streamingContent === 'string' ? streamingContent : streamingContent.html;

                                    // Format content based on tool type with prefixes
                                    if (STREAMABLE_TOOLS.COMMAND_TOOLS.has(toolName || '')) {
                                        const prefix = '$ ';
                                        // For commands, use plain text with prefix
                                        return prefix + contentToDisplay;
                                    }
                                    if (STREAMABLE_TOOLS.BROWSER_TOOLS.has(toolName || '')) {
                                        const prefix = '🌐 ';
                                        // For browser tools, render HTML if available
                                        if (htmlContent !== contentToDisplay) {
                                            return (
                                                <span>
                                                    {prefix}
                                                    <span dangerouslySetInnerHTML={{ __html: htmlContent }} />
                                                </span>
                                            );
                                        }
                                        return prefix + contentToDisplay;
                                    }
                                    if (STREAMABLE_TOOLS.WEB_TOOLS.has(toolName || '')) {
                                        const prefix = '🔍 ';
                                        // For web tools, render HTML if available
                                        if (htmlContent !== contentToDisplay) {
                                            return (
                                                <span>
                                                    {prefix}
                                                    <span dangerouslySetInnerHTML={{ __html: htmlContent }} />
                                                </span>
                                            );
                                        }
                                        return prefix + contentToDisplay;
                                    }
                                    if (STREAMABLE_TOOLS.OTHER_STREAMABLE.has(toolName || '')) {
                                        // For other tools, render HTML if available
                                        if (htmlContent !== contentToDisplay) {
                                            return <span dangerouslySetInnerHTML={{ __html: htmlContent }} />;
                                        }
                                        return contentToDisplay;
                                    }
                                    // For file operations, just return the content (no param names for cleaner code display)
                                    return contentToDisplay;
                                })()}
                            </div>
                            {/* Top gradient */}
                            <div className={`absolute top-0 left-0 right-0 h-8 pointer-events-none transition-all duration-400 ease-in-out ${shouldShowContent
                                ? 'opacity-100 bg-gradient-to-b from-zinc-100 dark:from-neutral-900 via-zinc-100/80 dark:via-neutral-900/80 to-transparent'
                                : 'opacity-0 bg-gradient-to-b from-muted via-muted/80 to-transparent'
                                }`} />
                            {/* Bottom gradient */}
                            <div className={`absolute bottom-0 left-0 right-0 h-8 pointer-events-none transition-all duration-400 ease-in-out ${shouldShowContent
                                ? 'opacity-100 bg-gradient-to-t from-zinc-100 dark:from-neutral-900 via-zinc-100/80 dark:via-neutral-900/80 to-transparent'
                                : 'opacity-0 bg-gradient-to-t from-muted via-muted/80 to-transparent'
                                }`} />
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Show normal tool button (non-streamable tools or non-expanded case)
    return (
        <div className="my-1">
            <button
                onClick={() => onToolClick?.(messageId, toolName)}
                className="animate-shimmer inline-flex items-center gap-1.5 py-1 px-1 pr-1.5 text-xs text-muted-foreground bg-muted hover:bg-muted/80 rounded-lg transition-colors cursor-pointer border border-neutral-200 dark:border-neutral-700/50"
            >
                <div className='border-2 bg-gradient-to-br from-neutral-200 to-neutral-300 dark:from-neutral-700 dark:to-neutral-800 flex items-center justify-center p-0.5 rounded-sm border-neutral-400/20 dark:border-neutral-600'>
                    <CircleDashed className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 animate-spin animation-duration-2000" />
                </div>
                <span className="font-mono text-xs text-foreground">{displayName}</span>
                {paramDisplay && <span className="ml-1 text-xs text-muted-foreground truncate max-w-[200px]" title={paramDisplay}>{paramDisplay}</span>}
            </button>
        </div>
    );
}; 