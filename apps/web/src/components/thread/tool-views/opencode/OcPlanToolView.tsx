'use client';

import React from 'react';
import { SquareKanban, CheckCircle, AlertCircle, ArrowRightLeft } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';

export function OcPlanToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocTool = (args._oc_tool as string) || '';
  const ocState = args._oc_state as any;
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = String(rawOutput).trim();

  const isExit = ocTool === 'plan_exit' || ocTool === 'plan-exit';
  const title = isExit ? 'Switch to Build' : 'Switch to Plan';
  const subtitle = isExit
    ? 'Transitioning from plan agent to build agent'
    : 'Transitioning from build agent to plan agent';

  const isError = toolResult?.success === false || !!toolResult?.error;

  if (isStreaming && !toolResult) {
    return <LoadingState title={title} subtitle={subtitle} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={SquareKanban}
            title={title}
            subtitle={subtitle}
          />
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/80 tracking-tight flex-shrink-0">
            <ArrowRightLeft className="w-2.5 h-2.5" />
            {isExit ? 'Build' : 'Plan'}
          </span>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-4">
            {output ? (
              <div className="text-sm text-muted-foreground leading-relaxed">{output}</div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <SquareKanban className="h-8 w-8 mb-2 opacity-40" />
                <span className="text-sm">{isExit ? 'Switching to build agent...' : 'Switching to plan agent...'}</span>
              </div>
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
              Rejected
            </Badge>
          ) : (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-emerald-500" />
              Switched
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}
