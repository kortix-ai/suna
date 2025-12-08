import React, { useMemo } from 'react';
import {
  Terminal,
  CheckCircle,
  AlertTriangle,
  CircleDashed,
  Clock,
  TerminalIcon,
  Loader2,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { useTheme } from 'next-themes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';

interface CommandSession {
  session_name?: string;
  sessionName?: string;
  command?: string;
  status?: string;
  pid?: number;
  cwd?: string;
  [key: string]: any;
}

export function ListCommandsToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const { resolvedTheme } = useTheme();
  const isDarkTheme = resolvedTheme === 'dark';

  // Extract commands/sessions from output - must be called before early return
  const commands = useMemo(() => {
    if (!toolResult?.output) return [];
    if (!toolResult?.output) return [];

    let output = toolResult.output;

    // Handle string output - try to parse as JSON
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output);
      } catch {
        // If parsing fails, try to extract array from string
        const arrayMatch = output.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          try {
            output = JSON.parse(arrayMatch[0]);
          } catch {
            return [];
          }
        } else {
          return [];
        }
      }
    }

    // Handle array output
    if (Array.isArray(output)) {
      return output;
    }

    // Handle object with commands/sessions array
    if (typeof output === 'object' && output !== null) {
      if (Array.isArray(output.commands)) {
        return output.commands;
      }
      if (Array.isArray(output.sessions)) {
        return output.sessions;
      }
      if (Array.isArray(output.results)) {
        return output.results;
      }
      // If it's a single object, wrap it in an array
      return [output];
    }

    return [];
  }, [toolResult?.output]);

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name) || 'Running Commands';

  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-zinc-500/20 to-zinc-600/10 border border-zinc-500/20">
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
              {actualIsSuccess ? 'Commands listed successfully' : 'Failed to list commands'}
            </Badge>
          )}

          {isStreaming && (
            <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              Listing
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
            title="Listing commands"
            filePath="Retrieving running commands..."
            showProgress={true}
          />
        ) : commands.length > 0 ? (
          <div className="h-full flex flex-col overflow-hidden">
            <ScrollArea className="flex-1 min-h-0">
              <div className="p-4 space-y-3">
                {commands.map((cmd: CommandSession, index: number) => {
                  const sessionName = cmd.session_name || cmd.sessionName || (typeof cmd === 'string' ? cmd : `Session ${index + 1}`);
                  const command = cmd.command || cmd.cmd || null;
                  const status = cmd.status || cmd.state || null;
                  const cwd = cmd.cwd || cmd.working_directory || null;

                  return (
                    <div
                      key={index}
                      className="bg-card border border-border rounded-lg p-3.5"
                    >
                      {/* Session name */}
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                          <TerminalIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                          Session
                        </Badge>
                        {status && (
                          <Badge
                            variant="outline"
                            className={`text-xs h-4 px-1.5 ${
                              status.toLowerCase().includes('running')
                                ? 'border-emerald-700/30 text-emerald-400'
                                : ''
                            }`}
                          >
                            {status}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-foreground font-mono">
                        {sessionName}
                      </div>

                      {/* Command if available */}
                      {command && (
                        <div className="mt-2 pt-2 border-t border-border">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                              <TerminalIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                              Command
                            </Badge>
                          </div>
                          <div className="font-mono text-xs text-foreground">
                            <span className="text-green-500 dark:text-green-400 font-semibold">$ </span>
                            <span className="text-foreground">{command}</span>
                          </div>
                        </div>
                      )}

                      {/* CWD if available */}
                      {cwd && (
                        <div className="mt-2 pt-2 border-t border-border">
                          <div className="text-xs text-muted-foreground font-mono">
                            {cwd}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
              <CircleDashed className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No Running Commands
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
              There are currently no running commands or sessions.
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && commands.length > 0 && (
            <Badge variant="outline" className="h-6 py-0.5 bg-zinc-50 dark:bg-zinc-900">
              <Terminal className="h-3 w-3 mr-1" />
              {commands.length} {commands.length === 1 ? 'Command' : 'Commands'}
            </Badge>
          )}
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
          <Clock className="h-3.5 w-3.5" />
          {toolTimestamp && !isStreaming
            ? formatTimestamp(toolTimestamp)
            : assistantTimestamp
              ? formatTimestamp(assistantTimestamp)
              : ''}
        </div>
      </div>
    </Card>
  );
}

