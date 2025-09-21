'use client';

import React from 'react';
import { Clock, CheckCircle, AlertTriangle, Loader2, Timer } from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, extractToolData, getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from '@/lib/utils';

interface WaitToolViewProps extends ToolViewProps {
  // No additional props needed
}

const extractWaitData = (toolContent?: any, isSuccess: boolean = true) => {
  let seconds = 0;
  let actualIsSuccess = isSuccess;

  if (toolContent) {
    try {
      const toolData = extractToolData(toolContent);
      const toolResult = toolData.toolResult;
      const arguments_ = toolResult?.arguments || {};
      
      seconds = arguments_.seconds || 0;
      actualIsSuccess = toolResult ? toolResult.isSuccess : isSuccess;
    } catch (error) {
      console.error('Error parsing wait tool content:', error);
    }
  }

  return {
    seconds,
    isSuccess: actualIsSuccess
  };
};

export function WaitToolView({
  name = 'wait',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: WaitToolViewProps) {
  const { seconds, isSuccess: actualIsSuccess } = extractWaitData(toolContent, isSuccess);

  const formatDuration = (seconds: number) => {
    if (seconds < 60) {
      return `${seconds}s`;
    } else {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }
  };

  const toolTitle = getToolTitle(name) || 'Wait';

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
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
            <Timer className="h-24 w-24 text-muted-foreground mb-6" />
            
            <div className="text-5xl font-medium text-foreground mb-3">
              {formatDuration(seconds)}
            </div>
            
            <div className="text-sm text-muted-foreground mb-4">
              {isStreaming 
                ? 'The system is currently pausing execution for the specified duration.' 
                : `The system paused execution for ${formatDuration(seconds)} as requested.`
              }
            </div>
            
            {seconds > 0 && (
              <div className="text-xs text-muted-foreground bg-muted/50 px-3 py-2 rounded-full">
                {isStreaming ? 'Please wait...' : 'Wait completed successfully'}
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
