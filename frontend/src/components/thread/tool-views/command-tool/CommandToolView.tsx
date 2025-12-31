import React, { useState, useEffect, useRef } from 'react';
import {
  Terminal,
  CheckCircle,
  AlertTriangle,
  CircleDashed,
  Clock,
  TerminalIcon,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LoadingState } from '../shared/LoadingState';
import { extractCommandData } from './_utils';
import { useToolStreamStore } from '@/stores/tool-stream-store';

export function CommandToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const toolCallId = toolCall?.tool_call_id || '';
  const streamingOutput = useToolStreamStore((state) => state.streamingOutputs.get(toolCallId) || '');
  const isOutputStreaming = useToolStreamStore((state) => state.streamingStatus.get(toolCallId) === 'streaming');

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
  
  // Use streaming output if available during streaming, otherwise use result output
  const displayOutput = isStreaming && streamingOutput ? streamingOutput : output;
  
  // Auto-scroll to bottom when streaming output updates
  useEffect(() => {
    if (isOutputStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamingOutput, isOutputStreaming]);
  
  const actualAssistantTimestamp = assistantTimestamp;
  const name = toolCall.function_name.replace(/_/g, '-');

  const displayText = name === 'check-command-output' ? sessionName : command;
  const displayLabel = name === 'check-command-output' ? 'Session' : 'Command';
  const displayPrefix = name === 'check-command-output' ? 'tmux:' : '$';

  const toolTitle = getToolTitle(name);

  // Check if this is a non-blocking command with just a status message
  const isNonBlockingCommand = React.useMemo(() => {
    if (!displayOutput) return false;

    // Check if output contains typical non-blocking command messages
    const nonBlockingPatterns = [
      'Command sent to tmux session',
      'Use check_command_output to view results',
      'Session still running',
      'completed: false'
    ];

    return nonBlockingPatterns.some(pattern =>
      displayOutput.toLowerCase().includes(pattern.toLowerCase())
    );
  }, [displayOutput]);

  // Check if there's actual command output to display
  const hasActualOutput = React.useMemo(() => {
    if (!displayOutput) return false;

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
      displayOutput.includes(pattern)
    ) || displayOutput.trim().length > 50; // Arbitrary threshold for "substantial" output
  }, [displayOutput, isNonBlockingCommand]);

  const formattedOutput = React.useMemo(() => {
    // For streaming output, show it directly without filtering
    if (isOutputStreaming && streamingOutput) {
      return streamingOutput.split('\n');
    }
    
    if (!displayOutput || !hasActualOutput) return [];
    let processedOutput = displayOutput;

    // Handle case where output is already an object
    if (typeof displayOutput === 'object' && displayOutput !== null) {
      try {
        processedOutput = JSON.stringify(displayOutput, null, 2);
      } catch (e) {
        processedOutput = String(displayOutput);
      }
    } else if (typeof displayOutput === 'string') {
      // Try to parse as JSON first
      try {
        if (displayOutput.trim().startsWith('{') || displayOutput.trim().startsWith('[')) {
          const parsed = JSON.parse(displayOutput);
          if (parsed && typeof parsed === 'object') {
            // If it's a complex object, stringify it nicely
            processedOutput = JSON.stringify(parsed, null, 2);
          } else {
            processedOutput = String(parsed);
          }
        } else {
          processedOutput = displayOutput;
        }
      } catch (e) {
        // If parsing fails, use as plain text
        processedOutput = displayOutput;
      }
    } else {
      processedOutput = String(displayOutput);
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
  }, [displayOutput, hasActualOutput, isOutputStreaming, streamingOutput]);

  return (
    <Card className="flex flex-col h-full overflow-hidden border-0 shadow-none p-0 rounded-none bg-card">
      <CardHeader className="flex-shrink-0 h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg border flex-shrink-0 bg-zinc-200/60 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700">
              <Terminal className="w-5 h-5 text-zinc-500 dark:text-zinc-400" />
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
                'Success' :
                (name === 'check-command-output' ? 'Failed to retrieve output' : 'Command failed')
              }
            </Badge>
          )}

          {isStreaming && (
            <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
              <span className="relative flex h-2 w-2 mr-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
              Live
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
        {isStreaming ? (
          <div className="flex flex-col h-full overflow-hidden">
            {/* Scrollable content area */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
              <div className="p-4 space-y-4">
                {command && (
                  <div className="bg-card border border-border rounded-lg overflow-hidden">
                    <div className="flex-shrink-0 p-3.5 pb-2 border-b border-border">
                      <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                        <TerminalIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                        Command
                      </Badge>
                    </div>
                    <div className="p-3.5 pt-2 overflow-x-auto">
                      <pre className="text-xs text-foreground font-mono whitespace-pre-wrap break-words">
                        <span className="text-green-500 dark:text-green-400 font-semibold">{displayPrefix} </span>
                        <span className="text-foreground">{command}</span>
                      </pre>
                    </div>
                  </div>
                )}
                
                {streamingOutput && (
                  <div className="bg-card border border-border rounded-lg flex flex-col overflow-hidden">
                    <div className="flex-shrink-0 p-3.5 pb-2 border-b border-border">
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                          <TerminalIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                          Output
                        </Badge>
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                          </span>
                          Live
                        </span>
                      </div>
                    </div>
                    <div className="p-3.5 pt-2">
                      <pre className="text-xs text-foreground font-mono whitespace-pre-wrap break-words">
                        {streamingOutput}
                        <span className="animate-pulse text-muted-foreground">▌</span>
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
            
            {!command && !streamingOutput && (
              <div className="flex-1 min-h-0 flex items-center justify-center">
                <LoadingState
                  icon={Terminal}
                  iconColor="text-blue-500 dark:text-blue-400"
                  bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
                  title={name === 'check-command-output' ? 'Checking command output' : 'Executing command'}
                  filePath={displayText || 'Processing command...'}
                  showProgress={true}
                />
              </div>
            )}
          </div>
        ) : displayText ? (
          <div className="flex flex-col h-full overflow-hidden">
            {/* Scrollable content area */}
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
              <div className="p-4 space-y-4">
                {/* Command section */}
                {command && (
                  <div className="bg-card border border-border rounded-lg overflow-hidden">
                    <div className="flex-shrink-0 p-3.5 pb-2 border-b border-border">
                      <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                        <TerminalIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                        Command
                      </Badge>
                    </div>
                    <div className="p-3.5 pt-2 overflow-x-auto">
                      <pre className="text-xs text-foreground font-mono whitespace-pre-wrap break-words">
                        <span className="text-green-500 dark:text-green-400 font-semibold">{displayPrefix} </span>
                        <span className="text-foreground">{command}</span>
                      </pre>
                    </div>
                  </div>
                )}

                {/* Show status message for non-blocking commands */}
                {isNonBlockingCommand && displayOutput && (
                  <div className="bg-card border border-border rounded-lg p-3.5">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                        <CircleDashed className="h-2.5 w-2.5 mr-1 opacity-70 text-blue-500" />
                        Status
                      </Badge>
                    </div>
                    <p className="text-xs text-foreground font-mono whitespace-pre-wrap break-words">{displayOutput}</p>
                  </div>
                )}

                {/* Output section */}
                {formattedOutput.length > 0 ? (
                  <div className="bg-card border border-border rounded-lg overflow-hidden">
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
                    <div className="p-3.5 pt-2 overflow-x-auto">
                      <pre className="text-xs text-foreground font-mono whitespace-pre-wrap break-words">
                        {formattedOutput.map((line, idx) => (
                          <span key={idx}>
                            {line}
                            {'\n'}
                          </span>
                        ))}
                      </pre>
                    </div>
                  </div>
                ) : !isNonBlockingCommand ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="bg-card border border-border rounded-lg p-4 text-center">
                      <CircleDashed className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">No output received</p>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
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

      <div className="flex-shrink-0 px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
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
