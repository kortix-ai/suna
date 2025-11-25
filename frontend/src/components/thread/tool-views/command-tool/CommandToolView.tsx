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
  Loader2,
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
  toolCall,
  toolResult,
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
    success: actualIsSuccess,
    timestamp: actualToolTimestamp,
  } = extractCommandData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );
  
  const actualAssistantTimestamp = assistantTimestamp;
  const name = toolCall.function_name.replace(/_/g, '-');

  const displayText = name === 'check-command-output' ? sessionName : command;
  const displayLabel = name === 'check-command-output' ? 'Session' : 'Command';
  const displayPrefix = name === 'check-command-output' ? 'tmux:' : '$';

  const toolTitle = getToolTitle(name);

  // Check if this is a non-blocking command with just a status message
  const isNonBlockingCommand = React.useMemo(() => {
    if (!output) return false;

    // Check if output contains typical non-blocking command messages
    const nonBlockingPatterns = [
      'Command sent to tmux session',
      'Use check_command_output to view results',
      'Session still running',
      'completed: false'
    ];

    return nonBlockingPatterns.some(pattern =>
      output.toLowerCase().includes(pattern.toLowerCase())
    );
  }, [output]);

  // Check if there's actual command output to display
  const hasActualOutput = React.useMemo(() => {
    if (!output) return false;

    // If it's a non-blocking command, don't show output section
    if (isNonBlockingCommand) return false;

    // Check if output contains actual command results (not just status messages)
    const actualOutputPatterns = [
      'root@',
      'COMMAND_DONE_',
      'Count:',
      'date:',
      'ls:',
      'pwd:'
    ];

    return actualOutputPatterns.some(pattern =>
      output.includes(pattern)
    ) || output.trim().length > 50; // Arbitrary threshold for "substantial" output
  }, [output, isNonBlockingCommand]);

  const formattedOutput = React.useMemo(() => {
    if (!output || !hasActualOutput) return [];
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
  }, [output, hasActualOutput]);

  const hasMoreLines = formattedOutput.length > 10;
  const previewLines = formattedOutput.slice(0, 10);
  const linesToShow = showFullOutput ? formattedOutput : previewLines;
  
  // Add empty lines for natural scrolling
  const emptyLines = Array.from({ length: 30 }, () => '');

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
              {actualIsSuccess ?
                (name === 'check-command-output' ? 'Output retrieved successfully' : 'Command executed successfully') :
                (name === 'check-command-output' ? 'Failed to retrieve output' : 'Command failed')
              }
            </Badge>
          )}

          {isStreaming && (
            <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              {name === 'check-command-output' ? 'Retrieving output' : 'Executing'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-shrink-0 p-4 pb-2">
              {/* Show partial command data if available during streaming */}
              {command && (
                <div className="mb-4 bg-card border border-border rounded-lg p-3.5">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                      <TerminalIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                      Command
                    </Badge>
                    <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                      Streaming
                    </Badge>
                  </div>
                  <div className="font-mono text-xs text-foreground">
                    <span className="text-green-500 dark:text-green-400 font-semibold">{displayPrefix} </span>
                    <span className="text-foreground">{command}</span>
                  </div>
                </div>
              )}
            </div>
            {!command && (
          <LoadingState
            icon={Terminal}
            iconColor="text-blue-500 dark:text-blue-400"
            bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
            title={name === 'check-command-output' ? 'Checking command output' : 'Executing command'}
            filePath={displayText || 'Processing command...'}
            showProgress={true}
          />
            )}
          </div>
        ) : displayText ? (
          <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-shrink-0 p-4 pb-2">
              {/* Command section */}
              {command && (
                <div className="mb-4 bg-card border border-border rounded-lg p-3.5">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                      <TerminalIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                      Command
                    </Badge>
                  </div>
                  <div className="font-mono text-xs text-foreground">
                    <span className="text-green-500 dark:text-green-400 font-semibold">{displayPrefix} </span>
                    <span className="text-foreground">{command}</span>
                  </div>
                </div>
              )}

              {/* Show status message for non-blocking commands */}
              {isNonBlockingCommand && output && (
                <div className="mb-4 bg-muted/50 border border-border rounded-lg p-3.5">
                  <div className="flex items-center gap-2 mb-2">
                    <CircleDashed className="h-4 w-4 text-blue-500" />
                    <span className="text-sm font-medium text-foreground">Command Status</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{output}</p>
                </div>
              )}
            </div>

            {/* Output section - fills remaining height and scrolls */}
            {formattedOutput.length > 0 ? (
              <div className="flex-1 min-h-0 px-4 pb-4">
                <div className="h-full bg-card border border-border rounded-lg flex flex-col overflow-hidden">
                  <div className="flex-shrink-0 p-3.5 pb-2 border-b border-border">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                        <TerminalIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                        Output
                      </Badge>
                      {exitCode !== null && exitCode !== 0 && (
                        <Badge variant="outline" className="text-xs h-4 px-1.5 border-red-700/30 text-red-400">
                          <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                          Error
                        </Badge>
                      )}
                    </div>
                  </div>
                  <ScrollArea className="flex-1 min-h-0">
                    <div className="p-3.5 pt-2">
                      <pre className="text-xs text-foreground font-mono whitespace-pre-wrap break-words">
                        {linesToShow.map((line, idx) => (
                          <span key={idx}>
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
                        <div className="text-muted-foreground mt-2 border-t border-border pt-2 text-xs font-mono">
                          + {formattedOutput.length - 10} more lines
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            ) : !isNonBlockingCommand ? (
              <div className="flex-1 flex items-center justify-center px-4 pb-4">
                <div className="bg-card border border-border rounded-lg p-4 text-center">
                  <CircleDashed className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">No output received</p>
                </div>
              </div>
            ) : null}
          </div>
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
