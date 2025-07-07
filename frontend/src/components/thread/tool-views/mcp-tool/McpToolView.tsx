import React, { useState, useEffect } from 'react';
import {
  PlugIcon,
  CheckCircle,
  AlertTriangle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Zap,
  Clock,
  Settings,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatTimestamp } from '../utils';
import { detectMCPFormat } from '../mcp-format-detector';
import { MCPContentRenderer } from '../mcp-content-renderer';
import {
  parseMCPResult,
  parseMCPToolCall,
  getMCPServerIcon,
  getMCPServerColor,
  formatMCPToolDisplayName,
  MCPResult,
  ParsedMCPTool
} from './_utils';

export function McpToolView({
  name = 'call-mcp-tool',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const { resolvedTheme } = useTheme();
  const [progress, setProgress] = useState(0);
  const [expandedArgs, setExpandedArgs] = useState(false);
  const [expandedResult, setExpandedResult] = useState(false);

  const parsedTool = parseMCPToolCall(assistantContent || '');
  const result = toolContent ? parseMCPResult(toolContent) : null;

  const serverName = result?.mcp_metadata?.server_name || parsedTool.serverName;
  const toolName = result?.mcp_metadata?.tool_name || parsedTool.toolName;
  const fullToolName = result?.mcp_metadata?.full_tool_name || parsedTool.fullToolName;
  const argumentsCount = result?.mcp_metadata?.arguments_count ?? Object.keys(parsedTool.arguments).length;

  const displayName = result?.mcp_metadata ?
    formatMCPToolDisplayName(serverName, toolName) :
    parsedTool.displayName;

  const ServerIcon = getMCPServerIcon(serverName);
  const serverColor = getMCPServerColor(serverName);

  useEffect(() => {
    if (isStreaming) {
      const timer = setInterval(() => {
        setProgress((prevProgress) => {
          if (prevProgress >= 95) {
            clearInterval(timer);
            return prevProgress;
          }
          return prevProgress + 8;
        });
      }, 400);
      return () => clearInterval(timer);
    } else {
      setProgress(100);
    }
  }, [isStreaming]);

  const hasArguments = Object.keys(parsedTool.arguments).length > 0;

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={cn(
              "relative p-2 rounded-lg bg-gradient-to-br border",
              serverColor
            )}>
              <ServerIcon className="w-5 h-5 text-current" />
              <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-white dark:bg-zinc-950 rounded-full flex items-center justify-center border border-zinc-200 dark:border-zinc-800">
                <PlugIcon className="w-2.5 h-2.5 text-zinc-600 dark:text-zinc-400" />
              </div>
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {displayName}
              </CardTitle>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                MCP Server • {serverName}
              </p>
            </div>
          </div>

          {!isStreaming && (
            <Badge
              variant="secondary"
              className={
                isSuccess && result && !result.isError
                  ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                  : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              }
            >
              {isSuccess && result && !result.isError ? (
                <CheckCircle className="h-3.5 w-3.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
              {isSuccess && result && !result.isError ? 'Completed successfully' : 'Execution failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="text-center w-full max-w-xs">
              <div className="w-16 h-16 rounded-full mx-auto mb-6 flex items-center justify-center bg-gradient-to-b from-indigo-100 to-indigo-50 shadow-inner dark:from-indigo-800/40 dark:to-indigo-900/60 dark:shadow-indigo-950/20 relative">
                <div className="absolute inset-0 rounded-full border-2 border-indigo-200 dark:border-indigo-700 animate-pulse" />
                <ServerIcon className="h-6 w-6 text-indigo-600 dark:text-indigo-400 relative z-10" />
                <div className="absolute -bottom-1 -right-1">
                  <Loader2 className="h-5 w-5 animate-spin text-indigo-500 dark:text-indigo-400" />
                </div>
              </div>
              <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                Executing MCP Tool
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-1">
                <span className="font-medium">{displayName}</span>
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-6">
                via {serverName} server
              </p>
              <Progress value={progress} className="w-full h-2" />
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2">{progress}%</p>
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">

              {/* Tool Information */}
              <div className="bg-zinc-50/70 dark:bg-zinc-900/30 p-4 rounded-lg border border-zinc-100 dark:border-zinc-800">
                <div className="flex items-center gap-2 mb-3">
                  <Settings className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
                  <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Tool Details</h3>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-zinc-500 dark:text-zinc-400">Server:</span>
                    <span className="ml-2 font-medium text-zinc-700 dark:text-zinc-300">
                      {serverName}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500 dark:text-zinc-400">Tool:</span>
                    <span className="ml-2 font-medium text-zinc-700 dark:text-zinc-300">
                      {toolName}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500 dark:text-zinc-400">Arguments:</span>
                    <span className="ml-2 font-medium text-zinc-700 dark:text-zinc-300">
                      {argumentsCount} parameter{argumentsCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500 dark:text-zinc-400">Status:</span>
                    <span className={cn(
                      "ml-2 font-medium",
                      isSuccess && result && !result.isError
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400"
                    )}>
                      {isSuccess && result && !result.isError ? 'Success' : 'Failed'}
                    </span>
                  </div>
                </div>

                {/* Show error type if available */}
                {result?.error_type && (
                  <div className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-700">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-red-500" />
                      <span className="text-sm text-red-600 dark:text-red-400">
                        Error Type: {result.error_type}
                      </span>
                    </div>
                  </div>
                )}
              </div>
              {/* Result Section */}
              {result && (
                <Card className={cn(
                  "border",
                  result.success && !result.isError
                    ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-900/10"
                    : "border-red-200 dark:border-red-800 bg-red-50/30 dark:bg-red-900/10"
                )}>
                  <div
                    className="p-3 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    onClick={() => setExpandedResult(!expandedResult)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {result.success && !result.isError ? (
                          <>
                            <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                            <h3 className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
                              Execution Result
                            </h3>
                          </>
                        ) : (
                          <>
                            <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
                            <h3 className="text-sm font-medium text-red-700 dark:text-red-300">
                              Error Result
                            </h3>
                          </>
                        )}
                      </div>
                      {expandedResult ? (
                        <ChevronUp className="h-4 w-4 text-zinc-500" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-zinc-500" />
                      )}
                    </div>
                  </div>

                  {expandedResult && (
                    <div className="border-t border-zinc-200 dark:border-zinc-800">
                      <MCPContentRenderer
                        detectionResult={detectMCPFormat(result.data || '')}
                        rawContent={result.data || ''}
                      />
                    </div>
                  )}
                </Card>
              )}

              {/* Timestamps */}
              {(assistantTimestamp || toolTimestamp) && (
                <div className="flex items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    <span>
                      {toolTimestamp ? (
                        `Completed ${formatTimestamp(toolTimestamp)}`
                      ) : assistantTimestamp ? (
                        `Started ${formatTimestamp(assistantTimestamp)}`
                      ) : (
                        ''
                      )}
                    </span>
                  </div>
                </div>
              )}

              {/* MCP Info Footer */}
              <div className="flex items-start gap-2 p-3 rounded-md bg-indigo-50/70 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800">
                <Zap className="h-4 w-4 text-indigo-600 dark:text-indigo-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-indigo-700 dark:text-indigo-300 mb-1">
                    Model Context Protocol (MCP)
                  </p>
                  <p className="text-xs text-indigo-600 dark:text-indigo-400">
                    This tool is provided by an external MCP server, enabling dynamic integration with specialized services and data sources.
                  </p>
                </div>
              </div>
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
} 