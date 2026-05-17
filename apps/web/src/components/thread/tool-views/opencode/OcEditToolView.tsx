'use client';

import React, { useState, useMemo } from 'react';
import {
  FileCode2,
  CheckCircle,
  AlertCircle,
  Plus,
  Minus,
  Columns2,
  Rows2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { useOcFileOpen } from './useOcFileOpen';
import { createTwoFilesPatch } from 'diff';
import { DiffView } from '@/components/diff/diff-view';

function getFilename(path: string | undefined): string {
  if (!path) return '';
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function getDirectory(path: string | undefined): string {
  if (!path) return '';
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '';
  return path.substring(0, idx);
}

// ============================================================================
// OcEditToolView
// ============================================================================

export function OcEditToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const filePath = (args.filePath as string) || (args.target_filepath as string) || '';
  const ocState = args._oc_state as any;

  const { openFile, toDisplayPath } = useOcFileOpen();

  const displayPath = toDisplayPath(filePath);
  const filename = getFilename(displayPath);
  const dir = getDirectory(displayPath);

  // Extract diff info from metadata
  const metadata = ocState?.metadata || {};
  const filediff = metadata?.filediff;
  const additions = filediff?.additions;
  const deletions = filediff?.deletions;

  const isError = toolResult?.success === false || !!toolResult?.error;

  // View mode: unified or split (side-by-side)
  const [viewMode, setViewMode] = useState<'unified' | 'split'>('split');

  // Build diff patch from before/after or oldString/newString
  const { patch, hasDiff } = useMemo(() => {
    const before = filediff?.before ?? (args.oldString as string) ?? '';
    const after = filediff?.after ?? (args.newString as string) ?? '';

    if (before || after) {
      const patchText = createTwoFilesPatch(
        displayPath || 'file',
        displayPath || 'file',
        String(before),
        String(after),
        '',
        '',
      );
      return { patch: patchText, hasDiff: true, before: String(before), after: String(after) };
    }

    return { patch: '', hasDiff: false, before: '', after: '' };
  }, [filediff?.before, filediff?.after, args.oldString, args.newString, displayPath]);

  if (isStreaming && !toolResult) {
    return (
      <LoadingState
        title="Editing File"
        subtitle={filename}
      />
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={FileCode2}
            title={filename || 'Edit File'}
            subtitle={dir}
            onTitleClick={filePath ? () => openFile(filePath) : undefined}
          />
          <div className="flex items-center gap-2 flex-shrink-0">
            {(additions != null || deletions != null) && (
              <div className="flex items-center gap-2 text-xs">
                {additions != null && (
                  <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                    <Plus className="h-3 w-3" />
                    {additions}
                  </span>
                )}
                {deletions != null && (
                  <span className="flex items-center gap-0.5 text-muted-foreground">
                    <Minus className="h-3 w-3" />
                    {deletions}
                  </span>
                )}
              </div>
            )}
            {/* View mode toggle */}
            {hasDiff && (
              <div className="flex items-center gap-0.5 ml-1">
                <button
                  onClick={() => setViewMode('unified')}
                  className={cn(
                    'p-1 rounded transition-colors cursor-pointer',
                    viewMode === 'unified'
                      ? 'text-foreground bg-muted/60'
                      : 'text-muted-foreground/40 hover:text-muted-foreground',
                  )}
                  title="Unified view"
                >
                  <Rows2 className="size-3.5" />
                </button>
                <button
                  onClick={() => setViewMode('split')}
                  className={cn(
                    'p-1 rounded transition-colors cursor-pointer',
                    viewMode === 'split'
                      ? 'text-foreground bg-muted/60'
                      : 'text-muted-foreground/40 hover:text-muted-foreground',
                  )}
                  title="Side-by-side view"
                >
                  <Columns2 className="size-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          {hasDiff ? (
            <DiffView
              patch={patch}
              layout={viewMode === 'split' ? 'split' : 'unified'}
              hideFileHeader
            />
          ) : (
            <div className="p-3">
              <div className="text-sm text-muted-foreground">
                File edited: <span className="font-mono text-foreground">{displayPath}</span>
              </div>
            </div>
          )}
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
              Saved
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}
