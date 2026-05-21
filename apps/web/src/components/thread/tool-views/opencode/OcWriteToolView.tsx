'use client';

import React from 'react';
import { FilePlus2, AlertCircle } from 'lucide-react';
import { ToolViewProps } from '../types';
import { LoadingState } from '../shared/LoadingState';
import { CodeHighlight } from '@/components/markdown/unified-markdown';
import { useOcFileOpen } from './useOcFileOpen';
import { formatTimestamp } from '../utils';
import {
  Counter,
  Status,
  ToolViewBody,
  ToolViewFoot,
  ToolViewHead,
  ToolViewShell,
} from '../shared/primitives';

function getFilename(path?: string): string {
  if (!path) return '';
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}
function getDirectory(path?: string): string {
  if (!path) return '';
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.substring(0, idx);
}

export function OcWriteToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const filePath = (args.filePath as string) || '';
  const content = (args.content as string) || '';

  const { openFile, toDisplayPath } = useOcFileOpen();
  const displayPath = toDisplayPath(filePath);
  const filename = getFilename(displayPath);
  const dir = getDirectory(displayPath);
  const ext = filename.split('.').pop() || '';
  const lineCount = content ? content.split('\n').length : 0;

  const isError = toolResult?.success === false || !!toolResult?.error;

  if (isStreaming && !toolResult) {
    return <LoadingState title="Writing file" subtitle={filename} />;
  }

  const ts = toolTimestamp && !isStreaming
    ? formatTimestamp(toolTimestamp)
    : assistantTimestamp ? formatTimestamp(assistantTimestamp) : undefined;

  return (
    <ToolViewShell>
      <ToolViewHead
        icon={FilePlus2}
        title={filename || 'Write File'}
        detail={dir}
        onTitleClick={filePath ? () => openFile(filePath) : undefined}
        actions={lineCount > 0 && <Counter value={lineCount} label={lineCount === 1 ? 'line' : 'lines'} />}
      />

      <ToolViewBody padded={false}>
        {content ? (
          <div className="px-4 py-3">
            <div className="rounded-2xl border border-border/50 overflow-hidden bg-foreground/[0.02]">
              <CodeHighlight
                code={content}
                language={ext || 'text'}
                className="[&>pre]:rounded-none [&>pre]:border-0 [&>pre]:bg-transparent"
              />
            </div>
          </div>
        ) : (
          <div className="px-4 py-3 text-[12px] text-muted-foreground/80 tracking-tight">
            File written:&nbsp;
            <span className="font-mono text-foreground/90">{displayPath}</span>
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
          <Status tone="success">Created</Status>
        )}
      </ToolViewFoot>
    </ToolViewShell>
  );
}
