'use client';

import React from 'react';
import { Clock, CheckCircle, AlertTriangle, Loader2, Timer } from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface WaitToolViewProps extends ToolViewProps {
  // No additional props needed
}

const extractWaitData = (
  toolCall: { function_name: string; arguments?: Record<string, any>; rawArguments?: string },
  toolResult?: { success?: boolean; output?: any },
  isSuccess: boolean = true,
  streamingText?: string,
  isStreaming: boolean = false
) => {
  let seconds = 0;
  
  // STREAMING: Use toolCall.rawArguments (per-tool-call) instead of shared streamingText
  const streamingSource = toolCall.rawArguments || streamingText;
  if (isStreaming && streamingSource) {
    try {
      const parsed = JSON.parse(streamingSource);
      if (parsed.seconds !== undefined && parsed.seconds !== null) {
        seconds = typeof parsed.seconds === 'string' ? parseInt(parsed.seconds, 10) : Number(parsed.seconds);
      } else if (parsed.duration !== undefined && parsed.duration !== null) {
        seconds = typeof parsed.duration === 'string' ? parseInt(parsed.duration, 10) : Number(parsed.duration);
      }
    } catch {
      // JSON incomplete - try to extract partial seconds value
      const secondsMatch = streamingSource.match(/"seconds"\s*:\s*(\d+)/);
      if (secondsMatch) {
        seconds = parseInt(secondsMatch[1], 10);
      } else {
        const durationMatch = streamingSource.match(/"duration"\s*:\s*(\d+)/);
        if (durationMatch) {
          seconds = parseInt(durationMatch[1], 10);
        }
      }
    }
  }
  
  // Fallback to toolCall.arguments if seconds not found from streaming
  if (seconds === 0) {
    const args = toolCall.arguments || {};
    if (args.seconds !== undefined && args.seconds !== null) {
      seconds = typeof args.seconds === 'string' ? parseInt(args.seconds, 10) : Number(args.seconds);
    } else if (args.duration !== undefined && args.duration !== null) {
      seconds = typeof args.duration === 'string' ? parseInt(args.duration, 10) : Number(args.duration);
    }
  }
  
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  return {
    seconds: Math.max(0, seconds),
    isSuccess: actualIsSuccess
  };
};

export function WaitToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  streamingText,
}: WaitToolViewProps) {
  // Defensive check - ensure toolCall is defined
  if (!toolCall) {
    console.warn('WaitToolView: toolCall is undefined.');
    return (
      <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
        <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4">
          <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
            Wait Tool Error
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            This tool view requires structured metadata.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { seconds, isSuccess: actualIsSuccess } = extractWaitData(
    toolCall,
    toolResult,
    isSuccess,
    streamingText,
    isStreaming
  );

  const formatDuration = (secs: number) => {
    if (secs < 60) {
      return `${secs}s`;
    } else {
      const minutes = Math.floor(secs / 60);
      const remainingSecs = secs % 60;
      return remainingSecs > 0 ? `${minutes}m ${remainingSecs}s` : `${minutes}m`;
    }
  };

  const toolTitle = getToolTitle(toolCall.function_name.replace(/_/g, '-')) || 'Wait';

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-orange-500/20 to-orange-600/10 border border-orange-500/20">
              <Clock className="w-5 h-5 text-orange-500 dark:text-orange-400" />
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
              {actualIsSuccess ? 'Completed' : 'Failed'}
            </Badge>
          )}

          {isStreaming && (
            <Badge className="bg-gradient-to-b from-orange-200 to-orange-100 text-orange-700 dark:from-orange-800/50 dark:to-orange-900/60 dark:text-orange-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              Waiting
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 overflow-hidden relative">
        <div className="h-full flex items-center justify-center p-8">
          <div className="flex flex-col items-center text-center max-w-md">
            {/* Timer icon with spinning animation when streaming */}
            <div className="relative mb-6">
              <Timer className={cn(
                "h-24 w-24",
                isStreaming ? "text-orange-500 dark:text-orange-400" : "text-muted-foreground"
              )} />
              {isStreaming && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="h-20 w-20 rounded-full border-4 border-orange-500/30 border-t-orange-500 animate-spin" />
                </div>
              )}
            </div>
            
            {/* Time display */}
            <div className="text-5xl font-medium text-foreground mb-3 tabular-nums">
              {formatDuration(seconds)}
            </div>
            
            <div className="text-sm text-muted-foreground mb-4">
              {isStreaming 
                ? `Pausing execution for ${formatDuration(seconds)}...`
                : `The system paused execution for ${formatDuration(seconds)} as requested.`
              }
            </div>
            
            {seconds > 0 && (
              <div className={cn(
                "text-xs px-3 py-2 rounded-full",
                isStreaming 
                  ? "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300"
                  : "bg-muted/50 text-muted-foreground"
              )}>
                {isStreaming ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Waiting in progress...
                  </span>
                ) : (
                  'Wait completed successfully'
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>

      {/* Footer */}
      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Badge className="h-6 py-0.5" variant="outline">
            <Clock className="h-3 w-3 mr-1" />
            Timing Control
          </Badge>
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
        </div>
      </div>
    </Card>
  );
}
