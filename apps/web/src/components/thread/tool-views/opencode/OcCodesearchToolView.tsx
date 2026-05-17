'use client';

import React from 'react';
import { Code2, AlertCircle, FolderOpen } from 'lucide-react';
import { ToolViewProps } from '../types';
import { LoadingState } from '../shared/LoadingState';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { formatTimestamp } from '../utils';
import {
  Counter,
  Status,
  ToolViewBody,
  ToolViewFoot,
  ToolViewHead,
  ToolViewShell,
} from '../shared/primitives';

export function OcCodesearchToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;
  const query = (args.query as string) || '';
  const tokensNum = (args.tokensNum as number) || 5000;
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = String(rawOutput).trim();
  const isError = toolResult?.success === false || !!toolResult?.error;

  if (isStreaming && !toolResult) {
    return <LoadingState title="Code search" subtitle={query} />;
  }

  const ts = toolTimestamp && !isStreaming
    ? formatTimestamp(toolTimestamp)
    : assistantTimestamp ? formatTimestamp(assistantTimestamp) : undefined;

  return (
    <ToolViewShell>
      <ToolViewHead
        icon={Code2}
        title="Code Search"
        detail={query}
        actions={tokensNum !== 5000 ? <Counter value={tokensNum.toLocaleString()} label="tokens" /> : undefined}
      />

      <ToolViewBody>
        {output ? (
          <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:!bg-foreground/[0.025] prose-pre:!border prose-pre:!border-border/50">
            <UnifiedMarkdown content={output} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground/60">
            <FolderOpen className="w-5 h-5 mb-2 opacity-50" />
            <span className="text-[12px] tracking-tight">
              No results for &ldquo;{query}&rdquo;
            </span>
          </div>
        )}
      </ToolViewBody>

      <ToolViewFoot timestamp={ts}>
        {isError ? (
          <Status tone="error">
            <AlertCircle className="w-3 h-3" />
            Failed
          </Status>
        ) : (
          <Status tone="success">Done</Status>
        )}
      </ToolViewFoot>
    </ToolViewShell>
  );
}
