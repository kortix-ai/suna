'use client';

import React, { useMemo, useState } from 'react';
import {
  FileCode2,
  CheckCircle,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Plus,
  ArrowRight,
  Trash2,
  PenLine,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { useOcFileOpen } from './useOcFileOpen';
import { DiffView } from '@/components/diff/diff-view';
import { cn } from '@/lib/utils';
import { STATUS_TEXT, STATUS_BG } from '@/components/ui/status';

interface PatchFile {
  relativePath: string;
  type: 'add' | 'update' | 'delete' | 'move';
  additions: number;
  deletions: number;
  before: string;
  after: string;
}

function getTypeConfig(type: string) {
  // Mono palette — status is conveyed by label + icon, not chip color.
  // Red kept only for genuinely destructive ops (delete).
  switch (type) {
    case 'add':
      return { label: 'Created', icon: Plus, color: 'text-foreground/80', bg: 'bg-foreground/[0.06]' };
    case 'update':
      return { label: 'Patched', icon: PenLine, color: 'text-foreground/80', bg: 'bg-foreground/[0.06]' };
    case 'delete':
      return { label: 'Deleted', icon: Trash2, color: STATUS_TEXT.destructive, bg: STATUS_BG.destructive };
    case 'move':
      return { label: 'Moved', icon: ArrowRight, color: 'text-foreground/80', bg: 'bg-foreground/[0.06]' };
    default:
      return { label: type, icon: FileCode2, color: 'text-muted-foreground/80', bg: 'bg-foreground/[0.04]' };
  }
}

function getFilename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function getDirectory(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '';
  return path.substring(0, idx);
}

export function OcApplyPatchToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;
  const rawOutput = toolResult?.output || ocState?.output || '';
  const metadata = ocState?.metadata || {};

  const { openFile, toDisplayPath } = useOcFileOpen();

  const isError = toolResult?.success === false || !!toolResult?.error;

  const files = useMemo(
    () => (Array.isArray(metadata.files) ? metadata.files : []) as PatchFile[],
    [metadata.files],
  );

  const totalAdditions = files.reduce((s, f) => s + (f.additions || 0), 0);
  const totalDeletions = files.reduce((s, f) => s + (f.deletions || 0), 0);

  const [expandedFile, setExpandedFile] = useState<number | null>(
    files.length === 1 ? 0 : null,
  );

  if (isStreaming && !toolResult) {
    return (
      <LoadingState
        title="Applying patches"
        subtitle={files.length > 0 ? `${files.length} files` : undefined}
      />
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={FileCode2}
            title="Apply Patch"
            subtitle={files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : undefined}
          />
          <div className="flex items-center gap-2 flex-shrink-0 ml-2 text-[11px] font-mono tracking-tight">
            {totalAdditions > 0 && (
              <span className="text-foreground/70">+{totalAdditions}</span>
            )}
            {totalDeletions > 0 && (
              <span className="text-muted-foreground/70">-{totalDeletions}</span>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          {files.length > 0 ? (
            <div className="py-1">
              {files.map((file, i) => {
                const config = getTypeConfig(file.type);
                const TypeIcon = config.icon;
                const name = getFilename(file.relativePath);
                const dir = getDirectory(file.relativePath);
                const isExpanded = expandedFile === i;
                const hasDiff = file.type !== 'delete' && (file.before || file.after);

                return (
                  <div key={i} className={i > 0 ? 'border-t border-border/60' : ''}>
                    {/* File header */}
                    <div
                      className="flex items-center gap-2.5 px-4 py-2.5 cursor-pointer hover:bg-muted transition-colors"
                      onClick={() => setExpandedFile(isExpanded ? null : i)}
                    >
                      {hasDiff ? (
                        isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        )
                      ) : (
                        <div className="w-3.5" />
                      )}

                      <Badge variant="outline" className={`h-5 py-0 px-1.5 text-[10px] font-semibold uppercase ${config.color} ${config.bg} border-none flex-shrink-0`}>
                        {config.label}
                      </Badge>

                      <span className="text-xs min-w-0 flex items-baseline gap-1.5 overflow-hidden flex-1">
                        <span
                          className="text-foreground font-medium font-mono whitespace-nowrap flex-shrink-0 cursor-pointer hover:text-primary transition-colors"
                          onClick={(e) => {
                            e.stopPropagation();
                            openFile(file.relativePath);
                          }}
                        >
                          {name}
                        </span>
                        {dir && (
                          <span className="text-muted-foreground/40 truncate text-[10px]">{dir}</span>
                        )}
                      </span>

                      <div className="flex items-center gap-1.5 text-[10.5px] flex-shrink-0 font-mono">
                        {file.additions > 0 && <span className="text-foreground/70">+{file.additions}</span>}
                        {file.deletions > 0 && <span className="text-muted-foreground/70">-{file.deletions}</span>}
                      </div>
                    </div>

                    {/* Expanded diff */}
                    {isExpanded && hasDiff && (
                      <PatchFileDiff before={file.before} after={file.after} filePath={file.relativePath} />
                    )}
                  </div>
                );
              })}
            </div>
          ) : isError ? (
            <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <p className="text-sm">{rawOutput || 'Patch failed'}</p>
            </div>
          ) : rawOutput ? (
            <div className="p-3">
              <pre className="text-xs text-muted-foreground font-mono whitespace-pre-wrap">{String(rawOutput).slice(0, 2000)}</pre>
            </div>
          ) : null}
        </ScrollArea>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <span className={cn('inline-flex items-center gap-1.5 text-[11px] tracking-tight', STATUS_TEXT.destructive)}>
              <AlertCircle className="w-3 h-3" />
              Failed
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/80 tracking-tight">
              <CheckCircle className="w-3 h-3 text-foreground/70" />
              {files.length} {files.length === 1 ? 'file' : 'files'} patched
            </span>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}

/** Per-file diff display — backed by Pierre's PatchDiff via DiffView. */
function PatchFileDiff({ before, after, filePath }: { before: string; after: string; filePath: string }) {
  return (
    <div className="border-t border-border/30 overflow-auto max-h-96">
      <DiffView
        before={{ name: `a/${filePath}`, contents: before || '' }}
        after={{ name: `b/${filePath}`, contents: after || '' }}
        layout="unified"
        hideFileHeader
      />
    </div>
  );
}
