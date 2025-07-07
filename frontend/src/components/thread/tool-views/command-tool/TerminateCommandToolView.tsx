import React, { useState, useEffect } from 'react';
import {
  Terminal,
  CheckCircle,
  AlertTriangle,
  CircleDashed,
  Clock,
  Loader2,
  ArrowRight,
  TerminalIcon,
  Power,
  StopCircle
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle, normalizeContentToString } from '../utils';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from "@/components/ui/scroll-area";
import { extractCommandData } from './_utils';

export function TerminateCommandToolView({
  name = 'terminate-command',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const { resolvedTheme } = useTheme();
  const isDarkTheme = resolvedTheme === 'dark';
  const [progress, setProgress] = useState(0);
  const [showFullOutput, setShowFullOutput] = useState(true);

  const {
    sessionName,
    output,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractCommandData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const rawSessionName = React.useMemo(() => {
    if (sessionName) return sessionName;

    if (!assistantContent) return null;

    const contentStr = normalizeContentToString(assistantContent);
    if (!contentStr) return null;

    try {
      const parsed = JSON.parse(contentStr);
      if (parsed.content) {
        const sessionMatch = parsed.content.match(
          /<terminate-command[^>]*session_name=["']([^"']+)["'][^>]*>/,
        );
        if (sessionMatch) {
          return sessionMatch[1].trim();
        }
      }
    } catch (e) {
      const sessionMatch = contentStr.match(
        /<terminate-command[^>]*session_name=["']([^"']+)["'][^>]*>/,
      );
      if (sessionMatch) {
        return sessionMatch[1].trim();
      }
    }

    return null;
  }, [assistantContent, sessionName]);

  const finalSessionName = rawSessionName?.trim() || sessionName;

  const toolTitle = getToolTitle(name) || 'Terminate Session';

  const terminationSuccess = React.useMemo(() => {
    if (!output) return false;

    const outputLower = output.toLowerCase();
    if (outputLower.includes('does not exist')) return false;
    if (outputLower.includes('terminated') || outputLower.includes('killed')) return true;

    if (typeof toolContent === 'string') {
      const toolResultMatch = toolContent.match(/ToolResult\(success=(true|false)/i);
      if (toolResultMatch) {
        return toolResultMatch[1].toLowerCase() === 'true';
      }
    }

    return actualIsSuccess;
  }, [output, actualIsSuccess, toolContent]);

  useEffect(() => {
    if (isStreaming) {
      const timer = setInterval(() => {
        setProgress((prevProgress) => {
          if (prevProgress >= 95) {
            clearInterval(timer);
            return prevProgress;
          }
          return prevProgress + 5;
        });
      }, 300);
      return () => clearInterval(timer);
    } else {
      setProgress(100);
    }
  }, [isStreaming]);

  const formattedOutput = React.useMemo(() => {
    if (!output) return [];
    let processedOutput = output;
    try {
      if (typeof output === 'string' && (output.trim().startsWith('{') || output.trim().startsWith('{'))) {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === 'object' && parsed.output) {
          processedOutput = parsed.output;
        }
      }
    } catch (e) {
    }

    processedOutput = String(processedOutput);
    processedOutput = processedOutput.replace(/\\\\/g, '\\');

    processedOutput = processedOutput
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");

    processedOutput = processedOutput.replace(/\\u([0-9a-fA-F]{4})/g, (match, group) => {
      return String.fromCharCode(parseInt(group, 16));
    });
    return processedOutput.split('\n');
  }, [output]);

  const hasMoreLines = formattedOutput.length > 10;
  const previewLines = formattedOutput.slice(0, 10);
  const linesToShow = showFullOutput ? formattedOutput : previewLines;

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg bg-gradient-to-br from-red-500/20 to-red-600/10 border border-red-500/20">
              <StopCircle className="w-5 h-5 text-red-500 dark:text-red-400" />
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
                terminationSuccess
                  ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                  : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              }
            >
              {terminationSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              )}
              {terminationSuccess ? 'Session terminated' : 'Termination failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="text-center w-full max-w-xs">
              <div className="w-16 h-16 rounded-full mx-auto mb-6 flex items-center justify-center bg-gradient-to-b from-red-100 to-red-50 shadow-inner dark:from-red-800/40 dark:to-red-900/60 dark:shadow-red-950/20">
                <Loader2 className="h-8 w-8 animate-spin text-red-500 dark:text-red-400" />
              </div>
              <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                Terminating session
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
                <span className="font-mono text-xs break-all">{finalSessionName || 'Processing termination...'}</span>
              </p>
              <Progress value={progress} className="w-full h-1" />
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2">{progress}%</p>
            </div>
          </div>
        ) : finalSessionName ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4">
              <div className="mb-4 bg-zinc-100 dark:bg-neutral-900 rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-800">
                <div className="bg-zinc-200 dark:bg-zinc-800 px-4 py-2 flex items-center gap-2">
                  <Power className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
                  <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Session</span>
                </div>
                <div className="p-4 font-mono text-sm text-zinc-700 dark:text-zinc-300 flex gap-2">
                  <span className="text-red-500 dark:text-red-400 select-none">●</span>
                  <code className="flex-1 break-all">{finalSessionName}</code>
                </div>
              </div>

              {output && (
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 flex items-center">
                      <ArrowRight className="h-4 w-4 mr-2 text-zinc-500 dark:text-zinc-400" />
                      Result
                    </h3>
                    <Badge
                      className={cn(
                        "ml-2",
                        terminationSuccess
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                          : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                      )}
                    >
                      {terminationSuccess ? 'Success' : 'Failed'}
                    </Badge>
                  </div>

                  <div className="bg-zinc-100 dark:bg-neutral-900 rounded-lg overflow-hidden border border-zinc-200/20">
                    <div className="bg-zinc-300 dark:bg-neutral-800 flex items-center justify-between dark:border-zinc-700/50">
                      <div className="bg-zinc-200 w-full dark:bg-zinc-800 px-4 py-2 flex items-center gap-2">
                        <TerminalIcon className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
                        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Termination output</span>
                      </div>
                      {!terminationSuccess && (
                        <Badge variant="outline" className="text-xs h-5 border-red-700/30 text-red-400">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          Error
                        </Badge>
                      )}
                    </div>
                    <div className="p-4 max-h-96 overflow-auto scrollbar-hide">
                      <pre className="text-xs text-zinc-600 dark:text-zinc-300 font-mono whitespace-pre-wrap break-all overflow-visible">
                        {linesToShow.map((line, index) => (
                          <div
                            key={index}
                            className="py-0.5 bg-transparent"
                          >
                            {line || ' '}
                          </div>
                        ))}
                        {!showFullOutput && hasMoreLines && (
                          <div className="text-zinc-500 mt-2 border-t border-zinc-700/30 pt-2">
                            + {formattedOutput.length - 10} more lines
                          </div>
                        )}
                      </pre>
                    </div>
                  </div>
                </div>
              )}

              {!output && !isStreaming && (
                <div className="bg-black rounded-lg overflow-hidden border border-zinc-700/20 shadow-md p-6 flex items-center justify-center">
                  <div className="text-center">
                    <CircleDashed className="h-8 w-8 text-zinc-500 mx-auto mb-2" />
                    <p className="text-zinc-400 text-sm">No output received</p>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
              <StopCircle className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No Session Found
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
              No session name was detected. Please provide a valid session to terminate.
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && finalSessionName && (
            <Badge variant="outline" className="h-6 py-0.5 bg-zinc-50 dark:bg-zinc-900">
              <StopCircle className="h-3 w-3 mr-1" />
              Terminate
            </Badge>
          )}
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
          <Clock className="h-3.5 w-3.5" />
          {actualToolTimestamp && !isStreaming
            ? formatTimestamp(actualToolTimestamp)
            : actualAssistantTimestamp
              ? formatTimestamp(actualAssistantTimestamp)
              : ''}
        </div>
      </div>
    </Card>
  );
} 