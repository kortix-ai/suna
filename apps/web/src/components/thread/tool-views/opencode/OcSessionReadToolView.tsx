'use client';

import React, { useMemo, useState } from 'react';
import {
  CheckCircle,
  AlertCircle,
  Eye,
  Activity,
  Wrench,
  FileText,
  ChevronDown,
  ChevronRight,
  Search,
} from 'lucide-react';
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

const MODE_ICONS: Record<string, typeof Eye> = {
  summary: Activity,
  tools: Wrench,
  full: FileText,
  search: Search,
};

const MODE_LABELS: Record<string, string> = {
  summary: 'Summary',
  tools: 'Tool Calls',
  full: 'Full Transcript',
  search: 'Search Results',
};

function parseStatus(output: string): { status: string; agent: string; messages: number; toolCalls: number } | null {
  const statusMatch = output.match(/\*\*Status:\*\*\s*(\w+)/);
  const agentMatch = output.match(/\*\*Agent:\*\*\s*(\w+)/);
  const msgMatch = output.match(/\*\*Messages:\*\*\s*(\d+)/);
  const toolMatch = output.match(/\*\*Tool calls:\*\*\s*(\d+)/);
  if (!statusMatch) return null;
  return {
    status: statusMatch[1],
    agent: agentMatch?.[1] ?? 'unknown',
    messages: parseInt(msgMatch?.[1] ?? '0'),
    toolCalls: parseInt(toolMatch?.[1] ?? '0'),
  };
}

export function OcSessionReadToolView({
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
  const mode = (args.mode as string) || (ocState?.input?.mode as string) || 'summary';
  const pattern = (args.pattern as string) || (ocState?.input?.pattern as string) || '';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const parsed = useMemo(() => parseStatus(output), [output]);
  const ModeIcon = MODE_ICONS[mode] || Eye;
  const modeLabel = MODE_LABELS[mode] || mode;
  const sid = sessionId.length > 16 ? `...${sessionId.slice(-12)}` : sessionId;

  if (isStreaming && !toolResult) {
    return <LoadingState title={`Reading session (${modeLabel})`} subtitle={sid} />;
  }

  const statusColor = parsed?.status === 'running' ? STATUS_TEXT.info :
    parsed?.status === 'complete' ? STATUS_TEXT.success :
    parsed?.status === 'failed' ? STATUS_TEXT.destructive : STATUS_TEXT.neutral;

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={ModeIcon}
            title={`Session ${modeLabel}`}
            subtitle={sid}
          />
          <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
            {parsed && (
              <Badge variant="outline" className={cn("h-5 py-0 text-xs", statusColor)}>
                {parsed.status}
              </Badge>
            )}
            {mode === 'search' && pattern && (
              <Badge variant="outline" className="h-5 py-0 text-xs">
                /{pattern}/
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        {output && !isError ? (
          <ScrollArea className="h-full w-full">
            <div className="p-3">
              <div className="prose prose-sm dark:prose-invert max-w-none text-xs">
                <UnifiedMarkdown content={output} />
              </div>
            </div>
          </ScrollArea>
        ) : isError ? (
          <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{output || 'Failed to read session'}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <Eye className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No session data</p>
          </div>
        )}
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
          ) : parsed ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-muted-foreground" />
              {parsed.messages} msgs · {parsed.toolCalls} tools
            </Badge>
          ) : null
        )}
      </ToolViewFooter>
    </Card>
  );
}
