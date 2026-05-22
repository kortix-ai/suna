'use client';

import React from 'react';
import { Cpu, CheckCircle, AlertCircle } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { cn } from '@/lib/utils';
import { STATUS_TEXT } from '@/components/ui/status';

function cleanTaskOutput(raw: string): string {
  return raw
    .replace(/^task_id:\s.*$/m, '')
    .replace(/^agentId:\s.*$/m, '')
    .replace(/<\/?task_result>/g, '')
    .replace(/<usage>[\s\S]*?<\/usage>/g, '')
    .trim();
}

export function OcTaskToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const subagentType = (args.subagent_type as string) || '';
  const description = (args.description as string) || '';
  const ocState = args._oc_state as any;
  const rawOutput = toolResult?.output || (ocState?.output) || '';
  const output = rawOutput ? cleanTaskOutput(String(rawOutput)) : '';

  const title = subagentType ? `Agent: ${subagentType}` : 'Sub-Agent Task';

  const isError = toolResult?.success === false || !!toolResult?.error;

  if (isStreaming && !toolResult) {
    return (
      <LoadingState
        title={title}
        subtitle={description}
      />
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Cpu}
            title={title}
            subtitle={description}
          />
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-3">
            {output ? (
              <UnifiedMarkdown content={String(output)} isStreaming={false} />
            ) : description ? (
              <div className="text-sm text-muted-foreground">{description}</div>
            ) : (
              <div className="text-sm text-muted-foreground">
                Delegating to sub-agent...
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
              Failed
            </Badge>
          ) : (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className={cn('h-3 w-3', STATUS_TEXT.success)} />
              Completed
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}
