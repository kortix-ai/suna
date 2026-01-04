import React, { useEffect, useRef, useState, useMemo } from 'react';
import { CircleDashed } from 'lucide-react';
import { getToolIcon, getUserFriendlyToolName, extractPrimaryParam } from '@/components/thread/utils';
import { AppIcon } from '../tool-views/shared/AppIcon';

// Media generation tools that show shimmer preview
const MEDIA_GENERATION_TOOLS = new Set([
    'image-edit-or-generate',
    'image_edit_or_generate',
    'Generating Image',
    'Editing Image', 
    'Generate Media',
]);

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

    SPREADSHEET_TOOLS: new Set([
        'Spreadsheet Create',
        'Spreadsheet Add Rows',
        'Spreadsheet Update Cell',
        'Spreadsheet Format Cells',
        'Spreadsheet Read',
        'Creating Spreadsheet',
        'Adding Rows',
        'Updating Cell',
        'Formatting Cells',
        'Reading Spreadsheet',
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
        'Getting Worker Config',
        'Searching MCP Servers',
        'Creating Credential Profile',
        'Connecting Credential Profile',
        'Checking Profile Connection',
        'Configuring Profile For Worker',
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
    onToolClick?: (messageId: string | null, toolName: string, toolCallId?: string) => void;
    showExpanded?: boolean;
    startTime?: number;
    toolCall?: any;
}

export const ShowToolStream: React.FC<ShowToolStreamProps> = ({
    content,
    messageId,
    onToolClick,
    showExpanded = false,
    startTime,
    toolCall
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [shouldShowContent, setShouldShowContent] = useState(false);
    const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
    const stableStartTimeRef = useRef<number | null>(null);

    const [throttledContent, setThrottledContent] = useState(content);
    const throttleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastUpdateRef = useRef<number>(0);

    useEffect(() => {
        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdateRef.current;

        if (timeSinceLastUpdate >= 100) {
            setThrottledContent(content);
            lastUpdateRef.current = now;
        } else {
            if (throttleTimeoutRef.current) {
                clearTimeout(throttleTimeoutRef.current);
            }
            throttleTimeoutRef.current = setTimeout(() => {
                setThrottledContent(content);
                lastUpdateRef.current = Date.now();
            }, 100 - timeSinceLastUpdate);
        }

        return () => {
            if (throttleTimeoutRef.current) {
                clearTimeout(throttleTimeoutRef.current);
            }
        };
    }, [content]);

    if (showExpanded && !stableStartTimeRef.current) {
        stableStartTimeRef.current = Date.now();
    }

    const { rawToolName, parsedToolCall } = useMemo(() => {
        let rawName: string | null = null;
        let parsed: any = null;
        
        try {
          parsed = JSON.parse(throttledContent);
          if (parsed.function?.name) {
            rawName = parsed.function.name;
          } else if (parsed.tool_name) {
            rawName = parsed.tool_name;
          } else if (parsed.function_name) {
            rawName = parsed.function_name;
          }
        } catch (e) {
          const match = throttledContent.match(/(?:function|tool)[_\-]?name["']?\s*[:=]\s*["']?([^"'\s]+)/i);
          if (match) {
            rawName = match[1];
          }
        }
        
        return { rawToolName: rawName, parsedToolCall: parsed };
    }, [throttledContent]);
    
    const toolName = getUserFriendlyToolName(rawToolName || '');
    const isEditFile = toolName === 'AI File Edit';
    const isCreateFile = toolName === 'Creating File';
    const isFullFileRewrite = toolName === 'Rewriting File';
    
    const effectiveToolCall = toolCall || parsedToolCall;
    
    // Check if tool is completed (has tool_result or completed flag)
    // tool_result can be an object with success/output/error, or just a truthy value
    const isCompleted = effectiveToolCall?.completed === true || 
                       (effectiveToolCall?.tool_result !== undefined && 
                        effectiveToolCall?.tool_result !== null &&
                        (typeof effectiveToolCall.tool_result === 'object' || Boolean(effectiveToolCall.tool_result)));

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
    const streamingContent = useMemo(() => {
        if (!throttledContent) return { html: '', plainText: '' };

        try {
            // Try to parse as JSON first
            const parsed = JSON.parse(throttledContent);
            
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
        return { html: throttledContent, plainText: throttledContent };
    }, [throttledContent, toolName, isEditFile, isCreateFile, isFullFileRewrite]);

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
    }, [throttledContent, shouldShowContent, shouldAutoScroll]);

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

    // Calculate paramDisplay before early return to satisfy Rules of Hooks
    const paramDisplay = useMemo(() => extractPrimaryParam(rawToolName || '', throttledContent), [rawToolName, throttledContent]);

    // Check if this is a media generation tool - show shimmer card
    const isMediaGenTool = MEDIA_GENERATION_TOOLS.has(rawToolName || '') || MEDIA_GENERATION_TOOLS.has(toolName || '');
    
    // Stable color ref for shimmer - placed before conditional return to satisfy Rules of Hooks
    const shimmerColorRef = useRef(
        ['from-purple-300/60 to-pink-300/60', 'from-blue-300/60 to-cyan-300/60', 
         'from-emerald-300/60 to-teal-300/60', 'from-orange-300/60 to-amber-300/60',
         'from-rose-300/60 to-red-300/60', 'from-indigo-300/60 to-violet-300/60']
        [Math.floor(Math.random() * 6)]
    );
    const [showShimmerColor, setShowShimmerColor] = useState(false);
    
    // Fade in shimmer color after delay
    useEffect(() => {
        if (isMediaGenTool) {
            const timer = setTimeout(() => setShowShimmerColor(true), 800);
            return () => clearTimeout(timer);
        }
    }, [isMediaGenTool]);

    if (!toolName) {
        return null;
    }
    
    if (isMediaGenTool) {
        const IconComponent = getToolIcon(rawToolName || '');
        
        // Check if this is a video generation (has video_options in arguments)
        const isVideoGeneration = effectiveToolCall?.arguments?.video_options !== undefined ||
            (typeof effectiveToolCall?.arguments === 'string' && effectiveToolCall.arguments.includes('video_options'));

        return (
            <div className="space-y-2">
                {/* Tool button - exactly like regular tools */}
                <button
                    onClick={() => onToolClick?.(messageId ?? null, toolName, effectiveToolCall?.tool_call_id)}
                    className="inline-flex items-center gap-1.5 h-8 px-2 py-1.5 text-xs text-muted-foreground bg-card hover:bg-card/80 rounded-lg transition-colors cursor-pointer border border-neutral-200 dark:border-neutral-700/50 max-w-full"
                >
                    <AppIcon toolCall={effectiveToolCall} size={14} className="h-3.5 w-3.5 text-muted-foreground shrink-0" fallbackIcon={IconComponent} />
                    <span className="font-mono text-xs text-foreground truncate">Generate Media</span>
                    {!isCompleted && (
                        <CircleDashed className="h-3.5 w-3.5 text-muted-foreground shrink-0 animate-spin ml-1" />
                    )}
                </button>

                {/* Shimmer below - aspect-video for video, aspect-square for image */}
                <div className={`relative w-full max-w-80 ${isVideoGeneration ? 'aspect-video' : 'aspect-square'} rounded-2xl overflow-hidden border border-neutral-200 dark:border-neutral-700/50`}>
                    {/* Gray base layer - contained with rounded corners */}
                    <div className="absolute inset-[-50%] bg-gradient-to-br from-zinc-300/60 to-zinc-400/60 dark:from-zinc-600/60 dark:to-zinc-700/60 blur-2xl" />
                    {/* Color layer that fades in - contained with rounded corners */}
                    <div 
                        className={`absolute inset-[-50%] bg-gradient-to-br ${shimmerColorRef.current} blur-2xl transition-opacity duration-1000`}
                        style={{ opacity: showShimmerColor ? 1 : 0 }}
                    />
                    <div className="absolute inset-0 bg-zinc-100/30 dark:bg-zinc-900/30 backdrop-blur-sm rounded-2xl" />
                    <div
                        className="absolute inset-0 rounded-2xl"
                        style={{
                            background: 'linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.4) 50%, transparent 70%)',
                            backgroundSize: '200% 100%',
                            animation: 'media-shimmer 1.8s ease-in-out infinite',
                        }}
                    />
                    <style>{`
                        @keyframes media-shimmer {
                            0% { background-position: 200% 0; }
                            100% { background-position: -200% 0; }
                        }
                    `}</style>
                </div>
            </div>
        );
    }

    // Check if this is a streamable tool
    const isToolStreamable = isStreamableTool(toolName);

    const IconComponent = getToolIcon(rawToolName || '');
    const displayName = toolName;

    // Always show tool button, conditionally show content below for streamable tools
    if (showExpanded && isToolStreamable) {
        return (
            <div>
                {/* Always render the container for smooth transitions */}
                <div className={`border border-neutral-200 dark:border-neutral-700/50 rounded-2xl overflow-hidden transition-all duration-500 ease-in-out transform-gpu ${shouldShowContent ? 'bg-zinc-100 dark:bg-neutral-900' : 'bg-muted scale-95 opacity-80'
                    }`}>
                    {/* Tool name header */}
                    <button
                        onClick={() => onToolClick?.(messageId ?? null, toolName, effectiveToolCall?.tool_call_id)}
                        className={`w-full flex items-center gap-1.5 py-1 px-2 text-xs text-muted-foreground hover:bg-muted/80 transition-all duration-400 ease-in-out cursor-pointer ${shouldShowContent ? 'bg-muted' : 'bg-muted rounded-lg'
                            }`}
                    >
                        <div className='flex items-center justify-center p-1 rounded-sm'>
                            <AppIcon toolCall={effectiveToolCall} size={14} className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        </div>
                        <span className="font-mono text-xs text-foreground flex-1">{displayName}</span>
                        {paramDisplay && <span className="ml-1 text-xs text-muted-foreground truncate max-w-[200px]" title={paramDisplay}>{paramDisplay}</span>}
                        {!isCompleted && (
                            <CircleDashed className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 animate-spin animation-duration-2000 ml-auto" />
                        )}
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
                                    if (STREAMABLE_TOOLS.SPREADSHEET_TOOLS.has(toolName || '')) {
                                        // For spreadsheet tools, show with table emoji prefix
                                        if (htmlContent !== contentToDisplay) {
                                            return <span dangerouslySetInnerHTML={{ __html: htmlContent }} />;
                                        }
                                        return contentToDisplay;
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

    return (
        <div className="min-w-0 max-w-full">
            <button
                onClick={() => onToolClick?.(messageId ?? null, toolName, effectiveToolCall?.tool_call_id)}
                className="inline-flex items-center gap-1.5 h-8 px-2 py-1.5 text-xs text-muted-foreground bg-card hover:bg-card/80 rounded-lg transition-colors cursor-pointer border border-neutral-200 dark:border-neutral-700/50 max-w-full"
            >
                <div className='flex items-center justify-center flex-shrink-0'>
                    <AppIcon toolCall={effectiveToolCall} size={14} className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" fallbackIcon={IconComponent} />
                </div>
                <span className="font-mono text-xs text-foreground truncate">{displayName}</span>
                {paramDisplay && <span className="ml-1 text-xs text-muted-foreground truncate max-w-[150px] sm:max-w-[200px]" title={paramDisplay}>{paramDisplay}</span>}
                {!isCompleted && (
                    <CircleDashed className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 animate-spin animation-duration-2000 ml-1" />
                )}
            </button>
        </div>
    );
}; 