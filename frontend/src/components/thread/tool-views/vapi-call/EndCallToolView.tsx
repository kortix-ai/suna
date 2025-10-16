import React from 'react';
import { PhoneOff, CheckCircle, AlertTriangle } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { extractEndCallData } from './_utils';
import { getToolTitle } from '../utils';

export function EndCallToolView({
  name = 'end-call',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const callData = extractEndCallData(toolContent);
  const toolTitle = getToolTitle(name);

  if (!callData) {
    return <div className="text-sm text-muted-foreground">No end call data available</div>;
  }

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-red-500/20 to-red-600/10 border border-red-500/20">
              <PhoneOff className="w-5 h-5 text-red-500 dark:text-red-400" />
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
                isSuccess
                  ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                  : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              }
            >
              {isSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              )}
              {isSuccess ? 'Call ended successfully' : 'Failed to end call'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-3">
        {assistantContent && (
          <div className="text-sm text-foreground">{assistantContent}</div>
        )}

        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Call ID</div>
          <div className="text-sm font-mono text-foreground bg-muted/50 rounded p-2 border border-border">
            {callData.call_id}
          </div>
        </div>

        {callData.message && (
          <div className="text-sm text-muted-foreground bg-emerald-500/10 rounded-lg p-3 border border-emerald-500/20">
            {callData.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

