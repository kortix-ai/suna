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
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { extractCommandData } from './_utils';
import { useToolStreamStore } from '@/stores/tool-stream-store';
import { useSmoothToolField, useSmoothText } from '@/hooks/messages';

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

  // Apply smooth text streaming for command field
  const rawArguments = toolCall?.rawArguments || toolCall?.arguments;
  const smoothFields = useSmoothToolField(
    (typeof rawArguments === 'object' && rawArguments) ? rawArguments : {},
    { interval: 50 }
  );
  const smoothCommand = (smoothFields as any).command || (typeof rawArguments === 'object' ? rawArguments?.command : '') || '';
  const isCommandAnimating = isStreaming && !toolResult;

  // Apply smooth text streaming for output (use useSmoothText since output is a plain string)
  const smoothOutput = useSmoothText(
    streamingOutput || output || '',
    { speed: 120 }
  );
  const isOutputAnimating = isStreaming && isOutputStreaming && !toolResult;
  
  // Use smooth streaming output when available, otherwise use regular streaming output or result output
  const displayOutput = isStreaming && isOutputStreaming && smoothOutput 
    ? smoothOutput 
    : (isStreaming && streamingOutput ? streamingOutput : output);
  
  // Use smooth command when streaming
  const displayCommand = isStreaming && smoothCommand ? smoothCommand : command;
  
  // Auto-scroll to bottom when streaming output updates
  useEffect(() => {
    if (isOutputStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamingOutput, isOutputStreaming]);
  
  const actualAssistantTimestamp = assistantTimestamp;
  const name = toolCall.function_name.replace(/_/g, '-');

  const displayText = name === 'check-command-output' ? sessionName : displayCommand;
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
          <ToolViewIconTitle icon={Terminal} title={toolTitle} />
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
                    <div className="flex-shrink-0 px-4 py-2.5 border-b border-border">
                      <Badge variant="outline" className="text-xs px-2.5 py-0.5 h-5 font-normal">
                        <TerminalIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                        Command
                      </Badge>
                    </div>
                    <div className="p-4 overflow-x-auto">
                      <pre className="text-xs text-foreground font-mono whitespace-pre-wrap break-words">
                        <span className="text-zinc-500 dark:text-zinc-400 font-semibold">{displayPrefix} </span>
                        <span className="text-foreground">{displayCommand}</span>
                        {isCommandAnimating && <span className="animate-pulse text-muted-foreground">▌</span>}
                      </pre>
                    </div>
                  </div>
                )}
                
                {streamingOutput && (
                  <div className="bg-card border border-border rounded-lg flex flex-col overflow-hidden">
                    <div className="flex-shrink-0 px-4 py-2.5 border-b border-border">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs px-2.5 py-0.5 h-5 font-normal">
                          <TerminalIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                          Output
                        </Badge>
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-zinc-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-zinc-500"></span>
                          </span>
                          Live
                        </span>
                      </div>
                    </div>
                    <div className="p-4">
                      <pre className="text-xs text-foreground font-mono whitespace-pre-wrap break-words">
                        {displayOutput}
                        {isOutputAnimating && <span className="animate-pulse text-muted-foreground">▌</span>}
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
                  iconColor="text-zinc-500 dark:text-zinc-400"
                  bgColor="bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60"
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
                    <div className="flex-shrink-0 px-4 py-2.5 border-b border-border">
                      <Badge variant="outline" className="text-xs px-2.5 py-0.5 h-5 font-normal">
                        <TerminalIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                        Command
                      </Badge>
                    </div>
                    <div className="p-4 overflow-x-auto">
                      <pre className="text-xs text-foreground font-mono whitespace-pre-wrap break-words">
                        <span className="text-zinc-500 dark:text-zinc-400 font-semibold">{displayPrefix} </span>
                        <span className="text-foreground">{displayCommand}</span>
                      </pre>
                    </div>
                  </div>
                )}

                {/* Show status message for non-blocking commands */}
                {isNonBlockingCommand && displayOutput && (
                  <div className="bg-card border border-border rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline" className="text-xs px-2.5 py-0.5 h-5 font-normal">
                        <CircleDashed className="h-2.5 w-2.5 mr-1 opacity-70 text-zinc-500 dark:text-zinc-400" />
                        Status
                      </Badge>
                    </div>
                    <p className="text-xs text-foreground font-mono whitespace-pre-wrap break-words">{displayOutput}</p>
                  </div>
                )}

                {/* Output section */}
                {formattedOutput.length > 0 ? (
                  <div className="bg-card border border-border rounded-lg overflow-hidden">
                    <div className="flex-shrink-0 px-4 py-2.5 border-b border-border">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs px-2.5 py-0.5 h-5 font-normal">
                          <TerminalIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                          Output
                        </Badge>
                        {exitCode !== null && exitCode !== 0 && (
                          <Badge variant="outline" className="text-xs h-5 px-2.5 py-0.5 border-red-700/30 text-red-400">
                            <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                            Error
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="p-4 overflow-x-auto">
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

      <ToolViewFooter
        assistantTimestamp={actualAssistantTimestamp}
        toolTimestamp={actualToolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && displayText && (
          <Badge variant="outline" className="h-6 py-0.5 bg-zinc-50 dark:bg-zinc-900">
            <Terminal className="h-3 w-3 mr-1" />
            {displayLabel}
          </Badge>
        )}
      </ToolViewFooter>
    </Card>
  );
}
