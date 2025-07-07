import React, { useState } from 'react';
import {
  Terminal,
  CheckCircle,
  AlertTriangle,
  CircleDashed,
  Code,
  Clock,
  ArrowRight,
  TerminalIcon,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { extractCommandData } from './_utils';

export function CommandToolView({
  name = 'execute-command',
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
    command,
    output,
    exitCode,
    sessionName,
    cwd,
    completed,
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

  const displayText = name === 'check-command-output' ? sessionName : command;
  const displayLabel = name === 'check-command-output' ? 'Session' : 'Command';
  const displayPrefix = name === 'check-command-output' ? 'tmux:' : '$';

  const toolTitle = getToolTitle(name);

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
            <div className="relative p-2 rounded-lg bg-gradient-to-br from-purple-500/20 to-purple-600/10 border border-purple-500/20">
              <Terminal className="w-5 h-5 text-purple-500 dark:text-purple-400" />
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
              {actualIsSuccess ?
                (name === 'check-command-output' ? 'Output retrieved successfully' : 'Command executed successfully') :
                (name === 'check-command-output' ? 'Failed to retrieve output' : 'Command failed')
              }
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Terminal}
            iconColor="text-purple-500 dark:text-purple-400"
            bgColor="bg-gradient-to-b from-purple-100 to-purple-50 shadow-inner dark:from-purple-800/40 dark:to-purple-900/60 dark:shadow-purple-950/20"
            title={name === 'check-command-output' ? 'Checking command output' : 'Executing command'}
            filePath={displayText || 'Processing command...'}
            showProgress={true}
          />
        ) : displayText ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4">


              {output && (
                <div className="mb-4">


                  <div className="bg-zinc-100 dark:bg-neutral-900 rounded-lg overflow-hidden border border-zinc-200/20">
                    <div className="bg-zinc-300 dark:bg-neutral-800 flex items-center justify-between dark:border-zinc-700/50">
                      <div className="bg-zinc-200 w-full dark:bg-zinc-800 px-4 py-2 flex items-center gap-2">
                        <TerminalIcon className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
                        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Terminal output</span>
                      </div>
                      {exitCode !== null && exitCode !== 0 && (
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
              <Terminal className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              {name === 'check-command-output' ? 'No Session Found' : 'No Command Found'}
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
              {name === 'check-command-output'
                ? 'No session name was detected. Please provide a valid session name to check.'
                : 'No command was detected. Please provide a valid command to execute.'
              }
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && displayText && (
            <Badge variant="outline" className="h-6 py-0.5 bg-zinc-50 dark:bg-zinc-900">
              <Terminal className="h-3 w-3 mr-1" />
              {displayLabel}
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