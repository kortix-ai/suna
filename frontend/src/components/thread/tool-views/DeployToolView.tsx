import React from 'react';
import {
    Rocket,
    CheckCircle,
    AlertTriangle,
    ExternalLink,
    Globe,
    Folder,
    TerminalIcon,
} from 'lucide-react';
import { ToolViewProps } from './types';
import { getToolTitle, normalizeContentToString } from './utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from './shared/LoadingState';

interface DeployResult {
    message?: string;
    output?: string;
    success?: boolean;
    url?: string;
}

function extractDeployData(assistantContent: any, toolContent: any): {
    name: string | null;
    directoryPath: string | null;
    deployResult: DeployResult | null;
    rawContent: string | null;
} {
    let name: string | null = null;
    let directoryPath: string | null = null;
    let deployResult: DeployResult | null = null;
    let rawContent: string | null = null;

    // Try to extract from assistant content first
    const assistantStr = normalizeContentToString(assistantContent);
    if (assistantStr) {
        try {
            const parsed = JSON.parse(assistantStr);
            if (parsed.parameters) {
                name = parsed.parameters.name || null;
                directoryPath = parsed.parameters.directory_path || null;
            }
        } catch (e) {
            // Try regex extraction
            const nameMatch = assistantStr.match(/name["']\s*:\s*["']([^"']+)["']/);
            const dirMatch = assistantStr.match(/directory_path["']\s*:\s*["']([^"']+)["']/);
            if (nameMatch) name = nameMatch[1];
            if (dirMatch) directoryPath = dirMatch[1];
        }
    }

    // Extract deploy result from tool content
    const toolStr = normalizeContentToString(toolContent);
    if (toolStr) {
        rawContent = toolStr;
        try {
            const parsed = JSON.parse(toolStr);

            // Handle the nested tool_execution structure
            let resultData = null;
            if (parsed.tool_execution && parsed.tool_execution.result) {
                resultData = parsed.tool_execution.result;
                // Also extract arguments if not found in assistant content
                if (!name && parsed.tool_execution.arguments) {
                    name = parsed.tool_execution.arguments.name || null;
                    directoryPath = parsed.tool_execution.arguments.directory_path || null;
                }
            } else if (parsed.output) {
                // Fallback to old format
                resultData = parsed;
            }

            if (resultData) {
                deployResult = {
                    message: resultData.output?.message || null,
                    output: resultData.output?.output || null,
                    success: resultData.success !== undefined ? resultData.success : true,
                };

                // Try to extract deployment URL from output
                if (deployResult.output) {
                    const urlMatch = deployResult.output.match(/https:\/\/[^\s]+\.pages\.dev[^\s]*/);
                    if (urlMatch) {
                        deployResult.url = urlMatch[0];
                    }
                }
            }
        } catch (e) {
            // If parsing fails, treat as raw content
            deployResult = {
                message: 'Deploy completed',
                output: toolStr,
                success: true,
            };
        }
    }

    return { name, directoryPath, deployResult, rawContent };
}

export function DeployToolView({
    name = 'deploy',
    assistantContent,
    toolContent,
    assistantTimestamp,
    toolTimestamp,
    isSuccess = true,
    isStreaming = false,
}: ToolViewProps) {
    const { name: projectName, directoryPath, deployResult, rawContent } = extractDeployData(
        assistantContent,
        toolContent
    );

    const toolTitle = getToolTitle(name);
    const actualIsSuccess = deployResult?.success !== undefined ? deployResult.success : isSuccess;

    // Clean up terminal output for display
    const cleanOutput = React.useMemo(() => {
        if (!deployResult?.output) return [];

        let output = deployResult.output;
        // Remove ANSI escape codes
        output = output.replace(/\u001b\[[0-9;]*m/g, '');
        // Replace escaped newlines with actual newlines
        output = output.replace(/\\n/g, '\n');

        return output.split('\n').filter(line => line.trim().length > 0);
    }, [deployResult?.output]);

    return (
        <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
            <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
                <div className="flex flex-row items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div className="relative p-2 rounded-lg bg-gradient-to-br from-orange-500/20 to-orange-600/10 border border-orange-500/20">
                            <Rocket className="w-5 h-5 text-orange-500 dark:text-orange-400" />
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
                            {actualIsSuccess ? 'Deploy successful' : 'Deploy failed'}
                        </Badge>
                    )}
                </div>
            </CardHeader>

            <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
                {isStreaming ? (
                    <LoadingState
                        icon={Rocket}
                        iconColor="text-orange-500 dark:text-orange-400"
                        bgColor="bg-gradient-to-b from-orange-100 to-orange-50 shadow-inner dark:from-orange-800/40 dark:to-orange-900/60 dark:shadow-orange-950/20"
                        title="Deploying website"
                        filePath={projectName || 'Processing deployment...'}
                        showProgress={true}
                    />
                ) : (
                    <ScrollArea className="h-full w-full">
                        <div className="p-4">

                            {/* Success State */}
                            {actualIsSuccess && deployResult ? (
                                <div className="space-y-4">
                                    {/* Deployment URL Card */}
                                    {deployResult.url && (
                                        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-sm">
                                            <div className="p-3">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <div className="w-6 h-6 rounded bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                                                        <Globe className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                                                    </div>
                                                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                                        Website Deployed
                                                    </span>
                                                    <Badge variant="outline" className="text-xs h-5 px-1.5 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800">
                                                        Live
                                                    </Badge>
                                                </div>

                                                <div className="bg-zinc-50 dark:bg-zinc-800 rounded p-2 mb-3">
                                                    <code className="text-xs font-mono text-zinc-700 dark:text-zinc-300 break-all">
                                                        {deployResult.url}
                                                    </code>
                                                </div>

                                                <Button
                                                    asChild
                                                    size="sm"
                                                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white h-8"
                                                >
                                                    <a href={deployResult.url} target="_blank" rel="noopener noreferrer">
                                                        <ExternalLink className="h-3.5 w-3.5 mr-2" />
                                                        Open Website
                                                    </a>
                                                </Button>
                                            </div>
                                        </div>
                                    )}

                                    {/* Terminal Output */}
                                    {cleanOutput.length > 0 && (
                                        <div className="bg-zinc-100 dark:bg-neutral-900 rounded-lg overflow-hidden border border-zinc-200/20">
                                            <div className="bg-accent px-4 py-2 flex items-center gap-2">
                                                <TerminalIcon className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
                                                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                                                    Deployment Log
                                                </span>
                                            </div>
                                            <div className="p-4 max-h-96 overflow-auto scrollbar-hide">
                                                <pre className="text-xs text-zinc-600 dark:text-zinc-300 font-mono whitespace-pre-wrap break-all">
                                                    {cleanOutput.map((line, index) => (
                                                        <div key={index} className="py-0.5">
                                                            {line || ' '}
                                                        </div>
                                                    ))}
                                                </pre>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                /* Failure State */
                                <div className="space-y-4">
                                    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                                        <div className="flex items-center gap-2 mb-2">
                                            <AlertTriangle className="h-5 w-5 text-red-600" />
                                            <h3 className="font-medium text-red-900 dark:text-red-100">
                                                Deployment Failed
                                            </h3>
                                        </div>
                                        <p className="text-sm text-red-700 dark:text-red-300">
                                            The deployment encountered an error. Check the logs below for details.
                                        </p>
                                    </div>

                                    {/* Raw Error Output */}
                                    {rawContent && (
                                        <div className="bg-zinc-100 dark:bg-neutral-900 rounded-lg overflow-hidden border border-zinc-200/20">
                                            <div className="bg-accent px-4 py-2 flex items-center gap-2">
                                                <TerminalIcon className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
                                                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                                                    Error Details
                                                </span>
                                            </div>
                                            <div className="p-4 max-h-96 overflow-auto scrollbar-hide">
                                                <pre className="text-xs text-zinc-600 dark:text-zinc-300 font-mono whitespace-pre-wrap break-all">
                                                    {rawContent}
                                                </pre>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                )}
            </CardContent>
        </Card>
    );
} 