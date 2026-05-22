'use client';

import React, { useMemo } from 'react';
import { Layers, AlertCircle, Check, X, Loader2 } from 'lucide-react';
import { ToolViewProps } from '../types';
import { LoadingState } from '../shared/LoadingState';
import { formatTimestamp } from '../utils';
import { cn } from '@/lib/utils';
import { STATUS_TEXT, STATUS_BG } from '@/components/ui/status';
import {
  Status,
  StatusDot,
  ToolViewBody,
  ToolViewFoot,
  ToolViewHead,
  ToolViewShell,
} from '../shared/primitives';

interface BatchDetail {
  tool: string;
  success: boolean;
}

export function OcBatchToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;
  const metadata = ocState?.metadata || {};

  const totalCalls = (metadata.totalCalls as number) || 0;
  const successful = (metadata.successful as number) || 0;
  const failed = (metadata.failed as number) || 0;

  const toolCalls = useMemo(() => {
    const details = (metadata.details as BatchDetail[]) || [];
    const tools = (metadata.tools as string[]) || [];
    if (details.length > 0) return details;
    const inputCalls = args.tool_calls as Array<{ tool: string }> | undefined;
    if (Array.isArray(inputCalls)) {
      return inputCalls.map((c) => ({ tool: c.tool, success: true }));
    }
    return tools.map((t) => ({ tool: t, success: true }));
  }, [metadata.details, metadata.tools, args.tool_calls]);

  const isError = toolResult?.success === false || !!toolResult?.error;
  const hasFailed = failed > 0;
  const isRunning = isStreaming && !toolResult;

  if (isRunning) {
    return (
      <LoadingState
        title="Batch execution"
        subtitle={toolCalls.length > 0 ? `${toolCalls.length} tools` : undefined}
      />
    );
  }

  const ts = toolTimestamp && !isStreaming
    ? formatTimestamp(toolTimestamp)
    : assistantTimestamp ? formatTimestamp(assistantTimestamp) : undefined;

  return (
    <ToolViewShell>
      <ToolViewHead
        icon={Layers}
        title="Batch"
        detail={
          totalCalls > 0
            ? `${successful}/${totalCalls} succeeded`
            : `${toolCalls.length} ${toolCalls.length === 1 ? 'tool' : 'tools'}`
        }
        actions={
          totalCalls > 0 ? (
            <>
              {successful > 0 && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/80 tracking-tight">
                  <StatusDot tone="success" />
                  {successful}
                </span>
              )}
              {failed > 0 && (
                <span className={cn('inline-flex items-center gap-1.5 text-[11px] tracking-tight', STATUS_TEXT.destructive)}>
                  <StatusDot tone="error" />
                  {failed}
                </span>
              )}
            </>
          ) : null
        }
      />

      <ToolViewBody padded={false}>
        {toolCalls.length === 0 ? (
          <div className="px-4 py-6 text-[12px] text-muted-foreground/70 tracking-tight text-center">
            No tool calls.
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {toolCalls.map((call, i) => (
              <li
                key={i}
                className={cn(
                  'flex items-center gap-2.5 px-4 py-2',
                  !call.success && STATUS_BG.destructive,
                )}
              >
                {!toolResult ? (
                  <Loader2 className="w-3 h-3 text-muted-foreground/60 animate-spin flex-shrink-0" />
                ) : call.success ? (
                  <Check className="w-3 h-3 text-foreground/70 flex-shrink-0" />
                ) : (
                  <X className={cn('w-3 h-3 flex-shrink-0', STATUS_TEXT.destructive)} />
                )}
                <span className="text-[12.5px] font-mono text-foreground/90 flex-1 truncate">
                  {call.tool}
                </span>
                <span className="text-[10.5px] text-muted-foreground/50 tabular-nums flex-shrink-0">
                  {i + 1}
                </span>
              </li>
            ))}
          </ul>
        )}
      </ToolViewBody>

      <ToolViewFoot timestamp={ts}>
        {isError || hasFailed ? (
          <Status tone="error">
            <AlertCircle className="w-3 h-3" />
            {isError ? 'Failed' : `${failed} failed`}
          </Status>
        ) : (
          <Status tone="success">All passed</Status>
        )}
      </ToolViewFoot>
    </ToolViewShell>
  );
}
