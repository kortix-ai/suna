import React from 'react';
import { Phone, Clock, MessageSquare, DollarSign, CheckCircle, AlertTriangle, Bot, User } from 'lucide-react';
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
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-green-500/20 to-green-600/10 border border-green-500/20">
              <Phone className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-foreground">
                {toolTitle}
              </CardTitle>
            </div>
          </div>
          {!isStreaming && (
            <Badge
              variant={isSuccess ? "default" : "destructive"}
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
            <div className="space-y-3 bg-muted/50 rounded-lg p-3 border border-border max-h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/30 scrollbar-track-transparent hover:scrollbar-thumb-muted-foreground/50">
              {callData.transcript!.map((msg, idx) => (
                <div
                  key={idx}
                  className={cn(
                    "text-sm p-3 rounded-2xl relative",
                    msg.role === 'assistant'
                      ? "bg-muted-foreground/20 border border-border ml-4"
                      : "bg-muted/80 border border-border mr-4"
                  )}
                >
                  <div className="font-medium text-xs text-muted-foreground mb-1 flex items-center gap-1">
                    {msg.role === 'assistant' ? (
                      <>
                        <Bot className="w-3 h-3 text-primary" />
                        AI Assistant
                      </>
                    ) : (
                      <>
                        <User className="w-3 h-3 text-muted-foreground" />
                        Caller
                      </>
                    )}
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

