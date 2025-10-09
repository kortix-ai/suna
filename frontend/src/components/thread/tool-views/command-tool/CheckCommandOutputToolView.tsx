import React, { useState } from 'react';
import {
    Terminal,
    CheckCircle,
    AlertTriangle,
    CircleDashed,
    Clock,
    TerminalIcon,
    Play,
    Square,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';

interface CheckCommandOutputData {
    sessionName: string | null;
    output: string | null;
    status: string | null;
    success: boolean;
    timestamp?: string;
}

function extractCheckCommandOutputData(
    assistantContent: any,
    toolContent: any,
    isSuccess: boolean,
    toolTimestamp?: string,
    assistantTimestamp?: string
): CheckCommandOutputData {
    let sessionName: string | null = null;
    let output: string | null = null;
    let status: string | null = null;
    let actualIsSuccess = isSuccess;
    const actualTimestamp = toolTimestamp || assistantTimestamp;

    // Parse content to extract data
    const parseContent = (content: any): any => {
        if (typeof content === 'string') {
            try {
                return JSON.parse(content);
            } catch (e) {
                return content;
            }
        }
        return content;
    };

    // Try to extract from tool content first (most likely to have the result)
    const toolParsed = parseContent(toolContent);

    if (toolParsed && typeof toolParsed === 'object') {
        // First, try to extract directly from tool_execution (the actual format being used)
        if (toolParsed.tool_execution && toolParsed.tool_execution.result) {
            const result = toolParsed.tool_execution.result;
            const args = toolParsed.tool_execution.arguments || {};
            
            if (result.output && typeof result.output === 'object') {
                sessionName = result.output.session_name || args.session_name || null;
                output = result.output.output || null;
                status = result.output.status || null;
            } else if (typeof result.output === 'string') {
                output = result.output;
                sessionName = args.session_name || null;
            }
            
            actualIsSuccess = result.success !== undefined ? result.success : actualIsSuccess;
        }
        // Handle the case where content is a JSON string
        else if (toolParsed.content && typeof toolParsed.content === 'string') {
            try {
                const contentParsed = JSON.parse(toolParsed.content);
                if (contentParsed.tool_execution) {
                    const toolExecution = contentParsed.tool_execution;

                    if (toolExecution.result && toolExecution.result.output) {
                        if (typeof toolExecution.result.output === 'object') {
                            // This is the nested format: { output: { output: "...", session_name: "...", status: "..." } }
                            const nestedOutput = toolExecution.result.output;
                            output = nestedOutput.output || null;
                            sessionName = nestedOutput.session_name || null;
                            status = nestedOutput.status || null;
                        } else if (typeof toolExecution.result.output === 'string') {
                            // Direct string output
                            output = toolExecution.result.output;
                        }
                        actualIsSuccess = toolExecution.result.success !== undefined ? toolExecution.result.success : actualIsSuccess;
                    }

                    // Extract session name from arguments if not found in output
                    if (!sessionName && toolExecution.arguments) {
                        sessionName = toolExecution.arguments.session_name || null;
                    }
                }
            } catch (e) {
                console.error('Failed to parse toolContent.content:', e);
            }
        }
    }

    // Fallback to assistant content if no data found in tool content
    if (!output && !sessionName) {
        const assistantParsed = parseContent(assistantContent);

        if (assistantParsed && typeof assistantParsed === 'object') {
            // Check for frontend_content first
            if (assistantParsed.frontend_content && assistantParsed.frontend_content.tool_execution) {
                const toolExecution = assistantParsed.frontend_content.tool_execution;

                if (toolExecution.result && toolExecution.result.output) {
                    if (typeof toolExecution.result.output === 'object') {
                        const nestedOutput = toolExecution.result.output;
                        output = nestedOutput.output || null;
                        sessionName = nestedOutput.session_name || null;
                        status = nestedOutput.status || null;
                    } else if (typeof toolExecution.result.output === 'string') {
                        output = toolExecution.result.output;
                    }
                }

                if (!sessionName && toolExecution.arguments) {
                    sessionName = toolExecution.arguments.session_name || null;
                }
            }
            // Fallback to content.content structure
            else if (assistantParsed.content && typeof assistantParsed.content === 'object') {
                if (assistantParsed.content.content && typeof assistantParsed.content.content === 'string') {
                    try {
                        const contentParsed = JSON.parse(assistantParsed.content.content);
                        if (contentParsed.tool_execution) {
                            const toolExecution = contentParsed.tool_execution;

                            if (toolExecution.result && toolExecution.result.output) {
                                if (typeof toolExecution.result.output === 'object') {
                                    const nestedOutput = toolExecution.result.output;
                                    output = nestedOutput.output || null;
                                    sessionName = nestedOutput.session_name || null;
                                    status = nestedOutput.status || null;
                                } else if (typeof toolExecution.result.output === 'string') {
                                    output = toolExecution.result.output;
                                }
                            }

                            if (!sessionName && toolExecution.arguments) {
                                sessionName = toolExecution.arguments.session_name || null;
                            }
                        }
                    } catch (e) {
                        console.error('Failed to parse assistant content.content:', e);
                    }
                }
            }
        }
    }

    return {
        sessionName,
        output,
        status,
        success: actualIsSuccess,
        timestamp: actualTimestamp
    };
}

export function CheckCommandOutputToolView({
    name = 'check-command-output',
    assistantContent,
    toolContent,
    assistantTimestamp,
    toolTimestamp,
    isSuccess = true,
    isStreaming = false,
}: ToolViewProps) {
    const { resolvedTheme } = useTheme();
    const isDarkTheme = resolvedTheme === 'dark';
    const [showFullOutput, setShowFullOutput] = useState(true);

    const {
        sessionName,
        output,
        status,
        success: actualIsSuccess,
        timestamp: actualTimestamp
    } = extractCheckCommandOutputData(
        assistantContent,
        toolContent,
        isSuccess,
        toolTimestamp,
        assistantTimestamp
    );

    const toolTitle = getToolTitle(name);

    const formattedOutput = React.useMemo(() => {
        if (!output) return [];

        let processedOutput = output;

        // Handle case where output is already an object
        if (typeof output === 'object' && output !== null) {
            try {
                processedOutput = JSON.stringify(output, null, 2);
            } catch (e) {
                processedOutput = String(output);
            }
        } else if (typeof output === 'string') {
            // Try to parse as JSON first
            try {
                if (output.trim().startsWith('{') || output.trim().startsWith('[')) {
                    const parsed = JSON.parse(output);
                    if (parsed && typeof parsed === 'object') {
                        // If it's a complex object, stringify it nicely
                        processedOutput = JSON.stringify(parsed, null, 2);
                    } else {
                        processedOutput = String(parsed);
                    }
                } else {
                    processedOutput = output;
                }
            } catch (e) {
                // If parsing fails, use as plain text
                processedOutput = output;
            }
        } else {
            processedOutput = String(output);
        }

        // Clean up escape sequences
        processedOutput = processedOutput.replace(/\\\\/g, '\\');
        processedOutput = processedOutput
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\'/g, "'");

        processedOutput = processedOutput.replace(/\\u([0-9a-fA-F]{4})/g, (_match, group) => {
            return String.fromCharCode(parseInt(group, 16));
        });

        return processedOutput.split('\n');
    }, [output]);

    const hasMoreLines = formattedOutput.length > 10;
    const previewLines = formattedOutput.slice(0, 10);
    const linesToShow = showFullOutput ? formattedOutput : previewLines;
    
    // Add empty lines for natural scrolling
    const emptyLines = Array.from({ length: 30 }, () => '');

    const isSessionRunning = status?.includes('still running') || status?.includes('running');

    return (
        <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
            <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
                <div className="flex flex-row items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
                            <Terminal className="w-5 h-5 text-blue-500 dark:text-blue-400" />
                        </div>
                        <div>
                            <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                                {toolTitle}
                            </CardTitle>
                        </div>
                    </div>

                    {!isStreaming && (
                        <Badge
                            variant="secondary"
                            className={
                                actualIsSuccess
                                    ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                                    : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
                            }
                        >
                            {actualIsSuccess ? (
                                <CheckCircle className="h-3.5 w-3.5 mr-1" />
                            ) : (
                                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                            )}
                            {actualIsSuccess ? 'Output retrieved successfully' : 'Failed to retrieve output'}
                        </Badge>
                    )}
                </div>
            </CardHeader>

            <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
                {isStreaming ? (
                    <LoadingState
                        icon={Terminal}
                        iconColor="text-blue-500 dark:text-blue-400"
                        bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
                        title="Checking command output"
                        filePath={sessionName || 'Processing session...'}
                        showProgress={true}
                    />
                ) : sessionName ? (
                    <ScrollArea className="h-full w-full">
                        <div className="bg-zinc-100 dark:bg-neutral-900 overflow-hidden">
                            <div className="bg-zinc-300 dark:bg-neutral-800 flex items-center justify-between dark:border-zinc-700/50">
                                <div className="bg-zinc-200 w-full dark:bg-zinc-800 px-4 py-2 flex items-center gap-2">
                                            <TerminalIcon className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
                                            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Terminal Session</span>
                                            <span className="text-xs text-zinc-500 dark:text-zinc-400">({sessionName})</span>
                                </div>
                            </div>
                            <div className="px-4 py-3 overflow-auto">
                                <pre className="text-xs text-zinc-600 dark:text-zinc-300 font-mono whitespace-pre-wrap break-all overflow-visible">
                                    {linesToShow.map((line, index) => (
                                        <span key={index}>
                                            {line}
                                            {'\n'}
                                        </span>
                                    ))}
                                    {/* Add empty lines for natural scrolling */}
                                    {showFullOutput && emptyLines.map((_, idx) => (
                                        <span key={`empty-${idx}`}>{'\n'}</span>
                                    ))}
                                </pre>
                                {!showFullOutput && hasMoreLines && (
                                    <div className="text-zinc-500 mt-2 border-t border-zinc-700/30 pt-2">
                                        + {formattedOutput.length - 10} more lines
                                    </div>
                                )}
                            </div>
                        </div>



                        {!output && !isStreaming && (
                            <div className="bg-black overflow-hidden p-12 flex items-center justify-center">
                                <div className="text-center">
                                    <CircleDashed className="h-8 w-8 text-zinc-500 mx-auto mb-2" />
                                    <p className="text-zinc-400 text-sm">No output received</p>
                                </div>
                            </div>
                        )}
                    </ScrollArea>
                ) : (
                    <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
                        <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
                            <Terminal className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
                        </div>
                        <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
                            No Session Found
                        </h3>
                        <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
                            No session name was detected. Please provide a valid session name to check.
                        </p>
                    </div>
                )}
            </CardContent>

            <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
                <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                    {!isStreaming && sessionName && (
                        <Badge variant="outline" className="h-6 py-0.5 bg-zinc-50 dark:bg-zinc-900">
                            <Terminal className="h-3 w-3 mr-1" />
                            Session
                        </Badge>
                    )}
                </div>

                <div className="text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                    <Clock className="h-3.5 w-3.5" />
                    {actualTimestamp && !isStreaming
                        ? formatTimestamp(actualTimestamp)
                        : ''}
                </div>
            </div>
        </Card>
    );
} 