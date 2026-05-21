'use client';

import React from 'react';
import { CheckCircle, AlertCircle, MessageSquare, Send } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';

export function OcSessionMessageToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const sessionId = (args.session_id as string) || (ocState?.input?.session_id as string) || '';
  const message = (args.message as string) || (ocState?.input?.message as string) || '';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const sid = sessionId.length > 16 ? `...${sessionId.slice(-12)}` : sessionId;

  if (isStreaming && !toolResult) {
    return <LoadingState title="Sending message" subtitle={sid} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Send}
            title="Message to Session"
            subtitle={sid}
          />
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-4 space-y-3">
            {message && (
              <div className="rounded-2xl bg-muted/30 border border-border/50 p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 mb-1.5 font-medium">Message</div>
                <p className="text-sm text-foreground/80 whitespace-pre-wrap">{message}</p>
              </div>
            )}
            {output && (
              <div className="text-xs text-muted-foreground/60">{output}</div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-emerald-500" />
              Sent
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}
