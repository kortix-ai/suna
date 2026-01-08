'use client';

import React from 'react';
import { Clock, CheckCircle, AlertTriangle, Timer } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
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
          <ToolViewIconTitle icon={Clock} title={toolTitle} />
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 overflow-hidden relative">
        <div className="h-full flex items-center justify-center p-8">
          <div className="flex flex-col items-center text-center max-w-md">
            {/* Timer icon with KortixLoader animation when streaming */}
            <div className="relative mb-6">
              {isStreaming ? (
                <KortixLoader customSize={96} />
              ) : (
                <Timer className="h-24 w-24 text-muted-foreground" />
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
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
                  : "bg-muted/50 text-muted-foreground"
              )}>
                {isStreaming ? (
                  <span className="flex items-center gap-2">
                    <KortixLoader customSize={12} />
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

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        <Badge className="h-6 py-0.5" variant="outline">
          <Clock className="h-3 w-3 mr-1" />
          Timing Control
        </Badge>
      </ToolViewFooter>
    </Card>
  );
}
