import React from 'react';
import { Phone, Clock, MessageSquare, DollarSign, CheckCircle, AlertTriangle } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { extractCallStatusData, formatPhoneNumber, formatDuration, statusConfig } from './_utils';
import { getToolTitle } from '../utils';

export function CallStatusToolView({
  name = 'get-call-details',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const callData = extractCallStatusData(toolContent);
  const toolTitle = getToolTitle(name);

  if (!callData) {
    return <div className="text-sm text-muted-foreground">No call status data available</div>;
  }

  const statusInfo = statusConfig[callData.status as keyof typeof statusConfig] || statusConfig.queued;
  const hasTranscript = callData.transcript && callData.transcript.length > 0;

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-indigo-500/20 to-indigo-600/10 border border-indigo-500/20">
              <Phone className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
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
              {isSuccess ? 'Call details retrieved' : 'Failed to get call details'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        {assistantContent && (
          <div className="text-sm text-foreground">{assistantContent}</div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Phone className="h-3 w-3" />
              Phone Number
            </div>
            <div className="text-sm font-medium text-foreground">
              {formatPhoneNumber(callData.phone_number)}
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              Duration
            </div>
            <div className="text-sm font-medium text-foreground">
              {formatDuration(callData.duration_seconds)}
            </div>
          </div>

          {callData.started_at && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Started At</div>
              <div className="text-sm text-foreground">
                {new Date(callData.started_at).toLocaleTimeString()}
              </div>
            </div>
          )}

          {callData.ended_at && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Ended At</div>
              <div className="text-sm text-foreground">
                {new Date(callData.ended_at).toLocaleTimeString()}
              </div>
            </div>
          )}

          {callData.cost !== undefined && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <DollarSign className="h-3 w-3" />
                Cost
              </div>
              <div className="text-sm font-medium text-foreground">
                ${callData.cost.toFixed(4)}
              </div>
            </div>
          )}

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Call ID</div>
            <div className="text-xs font-mono text-foreground truncate">
              {callData.call_id}
            </div>
          </div>
        </div>

        {hasTranscript && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              Conversation Transcript
            </div>
            <div className="space-y-2 bg-muted/30 rounded-lg p-3 border border-border max-h-64 overflow-y-auto">
              {callData.transcript!.map((msg, idx) => (
                <div
                  key={idx}
                  className={cn(
                    "text-sm p-2 rounded",
                    msg.role === 'assistant'
                      ? "bg-primary/5 border-l-2 border-primary/20"
                      : "bg-secondary/50 border-l-2 border-secondary/20"
                  )}
                >
                  <div className="font-medium text-xs text-muted-foreground mb-1">
                    {msg.role === 'assistant' ? '🤖 AI Assistant' : '👤 Caller'}
                  </div>
                  <div className="text-foreground">{msg.message}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

