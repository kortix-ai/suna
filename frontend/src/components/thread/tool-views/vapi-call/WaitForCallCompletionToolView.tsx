import React from 'react';
import { Phone, Clock, DollarSign, MessageSquare, CheckCircle, AlertTriangle } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { extractWaitForCallCompletionData, formatDuration, statusConfig } from './_utils';
import { getToolTitle } from '../utils';

export function WaitForCallCompletionToolView({
  name = 'wait-for-call-completion',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const data = extractWaitForCallCompletionData(toolContent);
  const toolTitle = getToolTitle(name);

  if (!data) {
    return <div className="text-sm text-muted-foreground">No call completion data available</div>;
  }

  const statusInfo = statusConfig[data.final_status as keyof typeof statusConfig] || statusConfig.completed;

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-indigo-500/20 to-indigo-600/10 border border-indigo-500/20">
              <CheckCircle className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
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
              {isSuccess ? 'Call completed successfully' : 'Call completion failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        {assistantContent && (
          <div className="text-sm text-foreground">{assistantContent}</div>
        )}

        <div className="bg-muted/30 rounded-lg p-4 border border-border space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">Final Status</span>
            <Badge className={cn("text-xs", statusInfo.color)}>
              {statusInfo.label}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Phone className="h-3 w-3" />
                Call ID
              </div>
              <div className="text-xs font-mono text-foreground truncate">
                {data.call_id}
              </div>
            </div>

            {data.duration_seconds !== undefined && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  Duration
                </div>
                <div className="text-sm font-medium text-foreground">
                  {formatDuration(data.duration_seconds)}
                </div>
              </div>
            )}

            {data.transcript_messages !== undefined && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <MessageSquare className="h-3 w-3" />
                  Transcript Messages
                </div>
                <div className="text-sm font-medium text-foreground">
                  {data.transcript_messages} messages
                </div>
              </div>
            )}

            {data.cost !== undefined && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <DollarSign className="h-3 w-3" />
                  Total Cost
                </div>
                <div className="text-sm font-medium text-foreground">
                  ${data.cost.toFixed(4)}
                </div>
              </div>
            )}
          </div>
        </div>

        {data.message && (
          <div className="text-sm text-muted-foreground bg-muted/30 rounded-lg p-3 border border-border">
            {data.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
