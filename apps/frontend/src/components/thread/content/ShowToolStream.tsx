import React, { useEffect, useRef, useState, useMemo } from 'react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { getToolIcon, getUserFriendlyToolName, extractPrimaryParam } from '@/components/thread/utils';
import { AppIcon } from '../tool-views/shared/AppIcon';
import { useSmoothToolField } from '@/hooks/messages';

/**
 * Optimistically extract a string field from partial/streaming JSON.
 * Works even when JSON is incomplete (still streaming).
 * 
 * @param jsonString - The potentially incomplete JSON string
 * @param fieldName - The field name to extract (e.g., 'file_path', 'file_contents')
 * @returns The extracted field value or null if not found
 */
function extractFieldFromPartialJson(jsonString: string, fieldName: string): string | null {
    if (!jsonString || typeof jsonString !== 'string') return null;
    
    // Look for the field in the JSON string
    // Pattern: "field_name": "value" or "field_name":"value"
    const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"`, 'i');
    const match = jsonString.match(pattern);
    
    if (!match || match.index === undefined) return null;
    
    // Find the start of the value (after the opening quote)
    const valueStart = match.index + match[0].length;
    let value = '';
    let i = valueStart;
    let escaped = false;
    
    // Parse the string value, handling escape sequences
    while (i < jsonString.length) {
        const char = jsonString[i];
        
        if (escaped) {
            // Handle escape sequences
            switch (char) {
                case 'n': value += '\n'; break;
                case 't': value += '\t'; break;
                case 'r': value += '\r'; break;
                case '"': value += '"'; break;
                case '\\': value += '\\'; break;
                default: value += char;
            }
            escaped = false;
        } else if (char === '\\') {
            escaped = true;
        } else if (char === '"') {
            // End of string value
            return value;
        } else {
            value += char;
        }
        i++;
    }
    
    // If we didn't find a closing quote, the JSON is still streaming
    // Return what we have so far (partial value)
    return value;
}

/**
 * Extract file path from partial JSON - tries multiple field names
 */
function extractFilePathFromPartialJson(jsonString: string): string | null {
    return extractFieldFromPartialJson(jsonString, 'file_path') ||
           extractFieldFromPartialJson(jsonString, 'target_file') ||
           extractFieldFromPartialJson(jsonString, 'path');
}

/**
 * Extract file contents from partial JSON
 */
function extractFileContentsFromPartialJson(jsonString: string): string | null {
    return extractFieldFromPartialJson(jsonString, 'file_contents') ||
           extractFieldFromPartialJson(jsonString, 'code_edit') ||
           extractFieldFromPartialJson(jsonString, 'content');
}

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

    // Throttle content updates to allow smooth streaming even when chunks arrive rapidly
    // Increased throttle time to 150ms to better handle rapid tool call chunks
    const [throttledContent, setThrottledContent] = useState(content);
    const throttleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastUpdateRef = useRef<number>(0);
    const pendingContentRef = useRef<string>(content);

    useEffect(() => {
        // Always update pending content immediately
        pendingContentRef.current = content;
        
        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdateRef.current;
        const THROTTLE_MS = 150; // Increased from 100ms to allow smoother streaming

        if (timeSinceLastUpdate >= THROTTLE_MS) {
            setThrottledContent(pendingContentRef.current);
            lastUpdateRef.current = now;
        } else {
            if (throttleTimeoutRef.current) {
                clearTimeout(throttleTimeoutRef.current);
            }
            throttleTimeoutRef.current = setTimeout(() => {
                setThrottledContent(pendingContentRef.current);
                lastUpdateRef.current = Date.now();
            }, THROTTLE_MS - timeSinceLastUpdate);
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

    // Determine which field to extract for smooth animation based on tool type
    const smoothFieldPath = useMemo(() => {
        if (isEditFile) return 'code_edit';
        if (isCreateFile || isFullFileRewrite) return 'file_contents';
        if (STREAMABLE_TOOLS.COMMAND_TOOLS.has(toolName || '')) return 'command';
        if (STREAMABLE_TOOLS.BROWSER_TOOLS.has(toolName || '')) return 'url';
        if (STREAMABLE_TOOLS.WEB_TOOLS.has(toolName || '')) return 'query';
        return 'content';
    }, [toolName, isEditFile, isCreateFile, isFullFileRewrite]);

    // Get raw arguments from tool call for smooth animation
    const rawToolArguments = useMemo(() => {
        if (effectiveToolCall?.arguments) {
            return effectiveToolCall.arguments;
        }
        // Fallback to parsing from content
        try {
            const parsed = JSON.parse(throttledContent);
            return parsed.arguments || parsed;
        } catch {
            return throttledContent;
        }
    }, [effectiveToolCall, throttledContent]);

    // Apply smooth animation to tool content (120 chars/sec for snappy code display)
    const smoothFieldValue = useSmoothToolField(
        rawToolArguments || {},
        { interval: 8 }
    );
    const isFieldAnimating = !isCompleted;

    // Extract streaming content from JSON or plain text
    const streamingContent = useMemo(() => {
        if (!throttledContent) return { html: '', plainText: '' };

        try {
            // Try to parse as JSON first
            const parsed = JSON.parse(throttledContent);
            
            // For file operations, extract file_contents or code_edit
            if (STREAMABLE_TOOLS.FILE_OPERATIONS.has(toolName || '')) {
                if (isEditFile && parsed.code_edit) {
                    // Use smooth value if available and animating
                    const value = isFieldAnimating ? smoothFieldValue : parsed.code_edit;
                    return { html: value, plainText: value };
                }
                if ((isCreateFile || isFullFileRewrite) && parsed.file_contents) {
                    const value = isFieldAnimating ? smoothFieldValue : parsed.file_contents;
                    return { html: value, plainText: value };
                }
                if (parsed.arguments) {
                    const args = typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : parsed.arguments;
                    if (isEditFile && args.code_edit) {
                        const value = isFieldAnimating ? smoothFieldValue : args.code_edit;
                        return { html: value, plainText: value };
                    }
                    if ((isCreateFile || isFullFileRewrite) && args.file_contents) {
                        const value = isFieldAnimating ? smoothFieldValue : args.file_contents;
                        return { html: value, plainText: value };
                    }
                }
            }

            // Command tools - extract command
            if (STREAMABLE_TOOLS.COMMAND_TOOLS.has(toolName || '')) {
                if (parsed.command) {
                    const value = isFieldAnimating ? smoothFieldValue : parsed.command;
                    return { html: `<strong>command:</strong> ${value}`, plainText: `command: ${value}` };
                }
                if (parsed.arguments?.command) {
                    const value = isFieldAnimating ? smoothFieldValue : parsed.arguments.command;
                    return { html: `<strong>command:</strong> ${value}`, plainText: `command: ${value}` };
                }
            }

            // Browser tools
            if (STREAMABLE_TOOLS.BROWSER_TOOLS.has(toolName || '')) {
                if (parsed.url) {
                    const value = isFieldAnimating ? smoothFieldValue : parsed.url;
                    return { html: `<strong>url:</strong> ${value}`, plainText: `url: ${value}` };
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
                    const value = isFieldAnimating ? smoothFieldValue : parsed.query;
                    return { html: `<strong>query:</strong> ${value}`, plainText: `query: ${value}` };
                }
                if (parsed.url) {
                    return { html: `<strong>url:</strong> ${parsed.url}`, plainText: `url: ${parsed.url}` };
                }
            }

            // Fallback: try to extract meaningful content from any tool
            // First check for common content fields
            if (parsed.file_contents) {
                const value = isFieldAnimating ? smoothFieldValue : parsed.file_contents;
                return { html: value, plainText: value };
            }
            if (parsed.code_edit) {
                const value = isFieldAnimating ? smoothFieldValue : parsed.code_edit;
                return { html: value, plainText: value };
            }
            if (parsed.content) {
                return { html: parsed.content, plainText: parsed.content };
            }
            if (parsed.text) {
                return { html: parsed.text, plainText: parsed.text };
            }
            if (parsed.message) {
                return { html: parsed.message, plainText: parsed.message };
            }
            // Check nested arguments for content fields
            if (parsed.arguments) {
                const args = typeof parsed.arguments === 'string' ? 
                    (() => { try { return JSON.parse(parsed.arguments); } catch { return null; } })() 
                    : parsed.arguments;
                if (args) {
                    if (args.file_contents) {
                        const value = isFieldAnimating ? smoothFieldValue : args.file_contents;
                        return { html: value, plainText: value };
                    }
                    if (args.code_edit) {
                        const value = isFieldAnimating ? smoothFieldValue : args.code_edit;
                        return { html: value, plainText: value };
                    }
                    if (args.content) {
                        return { html: args.content, plainText: args.content };
                    }
                    if (args.text) {
                        return { html: args.text, plainText: args.text };
                    }
                    if (args.command) {
                        return { html: `$ ${args.command}`, plainText: `$ ${args.command}` };
                    }
                    if (args.query) {
                        return { html: args.query, plainText: args.query };
                    }
                    if (args.url) {
                        return { html: args.url, plainText: args.url };
                    }
                }
            }
            // If we couldn't extract meaningful content, return empty for streaming display
            // This prevents showing raw JSON in the preview
            return { html: '', plainText: '' };
        } catch (e) {
            // JSON parse failed - this is streaming/partial JSON
            // Use optimistic parsing to extract fields from incomplete JSON
            
            // Try to extract file contents from partial JSON (for file operations)
            const partialFileContents = extractFileContentsFromPartialJson(throttledContent);
            if (partialFileContents) {
                // Use smooth animation value if animating, otherwise use extracted content
                const value = isFieldAnimating && smoothFieldValue ? smoothFieldValue : partialFileContents;
                return { html: value, plainText: value };
            }
            
            // Try to extract command from partial JSON
            const partialCommand = extractFieldFromPartialJson(throttledContent, 'command');
            if (partialCommand) {
                const value = isFieldAnimating && smoothFieldValue ? smoothFieldValue : partialCommand;
                return { html: `$ ${value}`, plainText: `$ ${value}` };
            }
            
            // Try to extract query from partial JSON
            const partialQuery = extractFieldFromPartialJson(throttledContent, 'query');
            if (partialQuery) {
                const value = isFieldAnimating && smoothFieldValue ? smoothFieldValue : partialQuery;
                return { html: value, plainText: value };
            }
            
            // Try to extract url from partial JSON
            const partialUrl = extractFieldFromPartialJson(throttledContent, 'url');
            if (partialUrl) {
                return { html: partialUrl, plainText: partialUrl };
            }
            
            // Try to extract text/message from partial JSON
            const partialText = extractFieldFromPartialJson(throttledContent, 'text') ||
                               extractFieldFromPartialJson(throttledContent, 'message');
            if (partialText) {
                return { html: partialText, plainText: partialText };
            }
        }

        // Fallback: return content as-is only if it looks like actual content (not JSON)
        if (throttledContent && !throttledContent.startsWith('{') && !throttledContent.startsWith('[')) {
            return { html: throttledContent, plainText: throttledContent };
        }
        // Return empty to avoid showing raw JSON
        return { html: '', plainText: '' };
    }, [throttledContent, toolName, isEditFile, isCreateFile, isFullFileRewrite, smoothFieldValue, isFieldAnimating]);

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
        ['from-zinc-300/60 to-zinc-400/60', 'from-zinc-350/60 to-zinc-450/60', 
         'from-neutral-300/60 to-neutral-400/60', 'from-stone-300/60 to-stone-400/60',
         'from-gray-300/60 to-gray-400/60', 'from-slate-300/60 to-slate-400/60']
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
                        <KortixLoader size="small" className="ml-1" />
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
                            <KortixLoader size="small" className="ml-auto" />
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
                    <KortixLoader size="small" className="ml-1" />
                )}
            </button>
        </div>
    );
}; 