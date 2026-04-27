'use client';

import React, { useState, useMemo } from 'react';
import {
  FileCode2,
  FilePlus2,
  FileX2,
  FileEdit,
  ChevronRight,
  ChevronDown,
  GitCompareArrows,
  Columns2,
  Rows2,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOpenCodeSessionDiff, useOpenCodeMessages } from '@/hooks/opencode/use-opencode-sessions';
import { ScrollArea } from '@/components/ui/scroll-area';
import { createTwoFilesPatch } from 'diff';
import type { FileDiff, ApplyPatchFile } from '@/ui/types';
import { useDiffHighlight, renderHighlightedLine } from '@/hooks/use-diff-highlight';

// ============================================================================
// Diff line renderer (unified view)
// ============================================================================

function DiffLines({ patch, filename }: { patch: string; filename: string }) {
  const diffLines = useMemo(() => patch.split('\n').slice(4), [patch]);

  // Extract code content (without +/-/space prefix) for highlighting
  const codeLines = useMemo(
    () =>
      diffLines.map((line) => {
        if (line.startsWith('@@') || line === '') return '';
        // Strip the +/-/space prefix
        return line.length > 0 ? line.substring(1) : '';
      }),
    [diffLines],
  );

  const highlighted = useDiffHighlight(codeLines, filename);

  return (
    <pre className="p-3 font-mono text-[11px] leading-[1.6] select-text whitespace-pre-wrap break-all">
      {diffLines.map((line, i) => {
        const isAdd = line.startsWith('+');
        const isDel = line.startsWith('-');
        const isHunk = line.startsWith('@@');

        let cls = 'text-muted-foreground/60';
        if (isAdd) cls = 'bg-emerald-500/5';
        else if (isDel) cls = 'bg-red-500/5';
        else if (isHunk) cls = 'text-blue-500/60 text-[10px]';

        // For hunk headers or empty lines, render plain
        if (isHunk || line === '') {
          return (
            <div key={i} className={cls}>
              {line || ' '}
            </div>
          );
        }

        const prefix = line[0] || ' ';
        const highlightedTokens = highlighted?.[i];

        if (highlightedTokens) {
          const html = renderHighlightedLine(highlightedTokens, codeLines[i]);
          return (
            <div key={i} className={cls}>
              <span
                className={cn(
                  isAdd && 'text-emerald-600 dark:text-emerald-400',
                  isDel && 'text-red-600 dark:text-red-400',
                )}
              >
                {prefix}
              </span>
              <span dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          );
        }

        // Fallback: no highlighting available
        return (
          <div
            key={i}
            className={cn(
              cls,
              isAdd && 'text-emerald-600 dark:text-emerald-400',
              isDel && 'text-red-600 dark:text-red-400',
            )}
          >
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

// ============================================================================
// Side-by-side diff renderer
// ============================================================================

interface SideBySideLine {
  left: { num: number | null; content: string; type: 'unchanged' | 'deleted' | 'empty' };
  right: { num: number | null; content: string; type: 'unchanged' | 'added' | 'empty' };
}

function parsePatchToSideBySide(patch: string): SideBySideLine[] {
  const lines = patch.split('\n').slice(4); // skip header
  const result: SideBySideLine[] = [];
  let leftNum = 0;
  let rightNum = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('@@')) {
      // Parse hunk header: @@ -leftStart,leftCount +rightStart,rightCount @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        leftNum = parseInt(match[1], 10) - 1;
        rightNum = parseInt(match[2], 10) - 1;
      }
      result.push({
        left: { num: null, content: line, type: 'unchanged' },
        right: { num: null, content: '', type: 'empty' },
      });
      i++;
      continue;
    }

    if (line.startsWith('-')) {
      // Collect consecutive deletions
      const deletions: string[] = [];
      while (i < lines.length && lines[i].startsWith('-')) {
        deletions.push(lines[i].substring(1));
        i++;
      }
      // Collect consecutive additions
      const additions: string[] = [];
      while (i < lines.length && lines[i].startsWith('+')) {
        additions.push(lines[i].substring(1));
        i++;
      }
      // Pair them up
      const maxLen = Math.max(deletions.length, additions.length);
      for (let j = 0; j < maxLen; j++) {
        const hasLeft = j < deletions.length;
        const hasRight = j < additions.length;
        result.push({
          left: {
            num: hasLeft ? ++leftNum : null,
            content: hasLeft ? deletions[j] : '',
            type: hasLeft ? 'deleted' : 'empty',
          },
          right: {
            num: hasRight ? ++rightNum : null,
            content: hasRight ? additions[j] : '',
            type: hasRight ? 'added' : 'empty',
          },
        });
      }
      continue;
    }

    if (line.startsWith('+')) {
      rightNum++;
      result.push({
        left: { num: null, content: '', type: 'empty' },
        right: { num: rightNum, content: line.substring(1), type: 'added' },
      });
      i++;
      continue;
    }

    // Context line
    leftNum++;
    rightNum++;
    result.push({
      left: { num: leftNum, content: line.startsWith(' ') ? line.substring(1) : line, type: 'unchanged' },
      right: { num: rightNum, content: line.startsWith(' ') ? line.substring(1) : line, type: 'unchanged' },
    });
    i++;
  }

  return result;
}

function SideBySideDiff({ patch, filename }: { patch: string; filename: string }) {
  const rows = useMemo(() => parsePatchToSideBySide(patch), [patch]);

  // Collect all content lines for highlighting (left + right interleaved)
  const { leftLines, rightLines } = useMemo(() => {
    const left: string[] = [];
    const right: string[] = [];
    for (const row of rows) {
      left.push(row.left.content || '');
      right.push(row.right.content || '');
    }
    return { leftLines: left, rightLines: right };
  }, [rows]);

  const leftHighlighted = useDiffHighlight(leftLines, filename);
  const rightHighlighted = useDiffHighlight(rightLines, filename);

  return (
    <div className="select-text overflow-hidden">
      <table className="w-full font-mono text-[11px] leading-[1.6] border-collapse table-fixed">
        <tbody>
          {rows.map((row, i) => {
            const leftTokens = leftHighlighted?.[i];
            const rightTokens = rightHighlighted?.[i];
            const isLeftHunk = row.left.content.startsWith('@@');

            return (
              <tr key={i}>
                {/* Left side (old) */}
                <td className="w-8 min-w-8 text-right pr-2 select-none text-muted-foreground/30 align-top border-r border-border/20">
                  {row.left.num ?? ''}
                </td>
                <td
                  className={cn(
                    'px-2 whitespace-pre-wrap break-all border-r border-border/30 w-[calc(50%-2rem)]',
                    row.left.type === 'deleted' && 'bg-red-500/10',
                    row.left.type === 'empty' && 'bg-muted/5',
                    row.left.type === 'unchanged' && 'text-muted-foreground/60',
                  )}
                >
                  {isLeftHunk ? (
                    <span className="text-blue-500/60 text-[10px]">{row.left.content}</span>
                  ) : leftTokens && row.left.content ? (
                    <span dangerouslySetInnerHTML={{ __html: renderHighlightedLine(leftTokens, row.left.content) }} />
                  ) : (
                    <span className={cn(row.left.type === 'deleted' && 'text-red-600 dark:text-red-400')}>
                      {row.left.content || ' '}
                    </span>
                  )}
                </td>
                {/* Right side (new) */}
                <td className="w-8 min-w-8 text-right pr-2 select-none text-muted-foreground/30 align-top border-r border-border/20">
                  {row.right.num ?? ''}
                </td>
                <td
                  className={cn(
                    'px-2 whitespace-pre-wrap break-all w-[calc(50%-2rem)]',
                    row.right.type === 'added' && 'bg-emerald-500/10',
                    row.right.type === 'empty' && 'bg-muted/5',
                    row.right.type === 'unchanged' && 'text-muted-foreground/60',
                  )}
                >
                  {rightTokens && row.right.content ? (
                    <span dangerouslySetInnerHTML={{ __html: renderHighlightedLine(rightTokens, row.right.content) }} />
                  ) : (
                    <span className={cn(row.right.type === 'added' && 'text-emerald-600 dark:text-emerald-400')}>
                      {row.right.content || ' '}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// Single file diff card
// ============================================================================

function FileDiffCard({ diff, viewMode, isFullscreen }: { diff: FileDiff; viewMode: 'unified' | 'split'; isFullscreen?: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = useMemo(() => {
    switch (diff.status) {
      case 'added': return <FilePlus2 className="size-3.5 text-emerald-500" />;
      case 'deleted': return <FileX2 className="size-3.5 text-red-500" />;
      default: return <FileEdit className="size-3.5 text-blue-500" />;
    }
  }, [diff.status]);

  const statusLabel = useMemo(() => {
    switch (diff.status) {
      case 'added': return 'Added';
      case 'deleted': return 'Deleted';
      default: return 'Modified';
    }
  }, [diff.status]);

  const statusColor = useMemo(() => {
    switch (diff.status) {
      case 'added': return 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10';
      case 'deleted': return 'text-red-600 dark:text-red-400 bg-red-500/10';
      default: return 'text-blue-600 dark:text-blue-400 bg-blue-500/10';
    }
  }, [diff.status]);

  const patch = useMemo(() => {
    if (diff.patch) return diff.patch;
    if (!diff.before && !diff.after) return '';
    return createTwoFilesPatch(
      diff.file, diff.file,
      diff.before || '', diff.after || '',
      '', '',
    );
  }, [diff.file, diff.patch, diff.before, diff.after]);

  const hasDiffContent = patch.length > 0;
  const filename = diff.file.split('/').pop() || diff.file;
  const directory = diff.file.includes('/') ? diff.file.substring(0, diff.file.lastIndexOf('/')) : '';

  return (
    <div className="rounded-lg border border-border/50 overflow-hidden bg-card">
      {/* File header */}
      <button
        onClick={() => hasDiffContent && setExpanded(!expanded)}
        className={cn(
          'flex items-center gap-2 w-full px-3 py-2 text-left transition-colors',
          hasDiffContent && 'hover:bg-muted/40 cursor-pointer',
          !hasDiffContent && 'cursor-default',
        )}
      >
        {hasDiffContent && (
          expanded
            ? <ChevronDown className="size-3 text-muted-foreground/50 flex-shrink-0" />
            : <ChevronRight className="size-3 text-muted-foreground/50 flex-shrink-0" />
        )}
        {!hasDiffContent && <span className="w-3" />}

        {statusIcon}

        <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
          <span className="text-xs font-medium text-foreground truncate">{filename}</span>
          {directory && (
            <span className="text-[10px] text-muted-foreground/50 truncate hidden sm:inline">
              {directory}
            </span>
          )}
        </div>

        {/* Status badge */}
        <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', statusColor)}>
          {statusLabel}
        </span>

        {/* Addition/deletion counts */}
        <span className="flex items-center gap-1.5 text-[10px] whitespace-nowrap flex-shrink-0">
          {diff.additions > 0 && <span className="text-emerald-500">+{diff.additions}</span>}
          {diff.deletions > 0 && <span className="text-red-500">-{diff.deletions}</span>}
        </span>
      </button>

      {/* Expanded diff content */}
      {expanded && hasDiffContent && (
        <div className={cn(
          'border-t border-border/40 bg-zinc-50/50 dark:bg-zinc-900/30 overflow-y-auto',
          isFullscreen ? 'max-h-[calc(100vh-12rem)]' : 'max-h-96',
        )}>
          {viewMode === 'split' ? (
            <SideBySideDiff patch={patch} filename={diff.file} />
          ) : (
            <DiffLines patch={patch} filename={diff.file} />
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Summary bar
// ============================================================================

function DiffSummaryBar({
  diffs,
  viewMode,
  onViewModeChange,
  isFullscreen,
  onToggleFullscreen,
}: {
  diffs: FileDiff[];
  viewMode: 'unified' | 'split';
  onViewModeChange: (mode: 'unified' | 'split') => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const totals = useMemo(() => {
    let additions = 0, deletions = 0, added = 0, deleted = 0, modified = 0;
    for (const d of diffs) {
      additions += d.additions;
      deletions += d.deletions;
      if (d.status === 'added') added++;
      else if (d.status === 'deleted') deleted++;
      else modified++;
    }
    return { additions, deletions, added, deleted, modified };
  }, [diffs]);

  return (
    <div className="flex items-center gap-3 px-5 py-3 pr-12 border-b border-border/40 bg-muted/20">
      <span className="text-xs text-muted-foreground">
        {diffs.length} {diffs.length === 1 ? 'file' : 'files'} changed
      </span>
      <div className="flex items-center gap-2 ml-auto text-[10px]">
        {totals.added > 0 && (
          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <FilePlus2 className="size-3" /> {totals.added}
          </span>
        )}
        {totals.modified > 0 && (
          <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400">
            <FileEdit className="size-3" /> {totals.modified}
          </span>
        )}
        {totals.deleted > 0 && (
          <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
            <FileX2 className="size-3" /> {totals.deleted}
          </span>
        )}
        <span className="text-muted-foreground/50 mx-1">|</span>
        {totals.additions > 0 && <span className="text-emerald-500">+{totals.additions}</span>}
        {totals.deletions > 0 && <span className="text-red-500 ml-1">-{totals.deletions}</span>}

        {/* View mode toggle */}
        <span className="text-muted-foreground/50 mx-1">|</span>
        <button
          onClick={() => onViewModeChange('unified')}
          className={cn(
            'p-1 rounded transition-colors cursor-pointer',
            viewMode === 'unified'
              ? 'text-foreground bg-muted/60'
              : 'text-muted-foreground/50 hover:text-muted-foreground',
          )}
          title="Unified view"
        >
          <Rows2 className="size-3.5" />
        </button>
        <button
          onClick={() => onViewModeChange('split')}
          className={cn(
            'p-1 rounded transition-colors cursor-pointer',
            viewMode === 'split'
              ? 'text-foreground bg-muted/60'
              : 'text-muted-foreground/50 hover:text-muted-foreground',
          )}
          title="Side-by-side view"
        >
          <Columns2 className="size-3.5" />
        </button>

        {/* Fullscreen toggle */}
        {onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            className="p-1 rounded transition-colors cursor-pointer text-muted-foreground/50 hover:text-muted-foreground"
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Extract diffs from message tool parts (fallback)
// ============================================================================

const EDIT_TOOLS = new Set(['edit', 'morph_edit']);
const PATCH_TOOLS = new Set(['apply_patch']);

function extractDiffsFromMessages(
  messages: Array<{ info: { role: string }; parts: Array<any> }> | undefined,
): FileDiff[] {
  if (!messages) return [];

  // Track last known state per file so we can build the cumulative diff
  const fileMap = new Map<string, { before: string; after: string }>();

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== 'tool') continue;
      const state = part.state;
      if (!state || (state.status !== 'completed' && state.status !== 'running')) continue;

      const toolName: string = part.tool ?? '';
      const input = state.input ?? {};
      const metadata = (state.metadata as Record<string, unknown>) ?? {};

      if (EDIT_TOOLS.has(toolName)) {
        const filePath = (input.filePath as string) || '';
        if (!filePath) continue;
        const filediff = metadata.filediff as Record<string, unknown> | undefined;
        const before = (filediff?.before as string) ?? (input.oldString as string) ?? '';
        const after = (filediff?.after as string) ?? (input.newString as string) ?? '';
        if (!before && !after) continue;

        const existing = fileMap.get(filePath);
        if (existing) {
          existing.after = after;
        } else {
          fileMap.set(filePath, { before, after });
        }
      } else if (PATCH_TOOLS.has(toolName)) {
        const files = (Array.isArray(metadata.files) ? metadata.files : []) as ApplyPatchFile[];
        for (const file of files) {
          const filePath = file.filePath || file.relativePath || '';
          if (!filePath) continue;
          const before = file.before ?? '';
          const after = file.after ?? '';
          if (!before && !after) continue;

          const existing = fileMap.get(filePath);
          if (existing) {
            existing.after = after;
          } else {
            fileMap.set(filePath, { before, after });
          }
        }
      }
    }
  }

  const result: FileDiff[] = [];
  for (const [file, { before, after }] of fileMap) {
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    let additions = 0;
    let deletions = 0;

    const beforeSet = new Set(beforeLines);
    const afterSet = new Set(afterLines);
    for (const line of afterLines) {
      if (!beforeSet.has(line)) additions++;
    }
    for (const line of beforeLines) {
      if (!afterSet.has(line)) deletions++;
    }

    let status: 'added' | 'deleted' | 'modified' = 'modified';
    if (!before) status = 'added';
    else if (!after) status = 'deleted';

    result.push({ file, before, after, additions, deletions, status });
  }

  return result;
}

// ============================================================================
// Main SessionDiffViewer
// ============================================================================

interface SessionDiffViewerProps {
  sessionId: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export function SessionDiffViewer({ sessionId, isFullscreen, onToggleFullscreen }: SessionDiffViewerProps) {
  const { data: apiDiffs, isLoading, error } = useOpenCodeSessionDiff(sessionId);
  const { data: messages } = useOpenCodeMessages(sessionId);
  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified');

  // Fall back to extracting diffs from tool part metadata when the API returns empty
  const messageDiffs = useMemo(
    () => extractDiffsFromMessages(messages as any),
    [messages],
  );

  const diffs = (apiDiffs && apiDiffs.length > 0) ? apiDiffs : messageDiffs;

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-5 py-4 pr-12 border-b border-border/40">
          <GitCompareArrows className="size-4 text-muted-foreground/40" />
          <span className="text-xs font-medium text-muted-foreground">Changes</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-5">
                <div className="h-3 w-3 bg-muted/30 rounded animate-pulse" />
                <div className="h-3 bg-muted/20 rounded animate-pulse" style={{ width: 120 + i * 40 }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error && diffs.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-5 py-4 pr-12 border-b border-border/40">
          <GitCompareArrows className="size-4 text-muted-foreground/40" />
          <span className="text-xs font-medium text-muted-foreground">Changes</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <p className="text-xs text-muted-foreground">Failed to load changes</p>
        </div>
      </div>
    );
  }

  if (!diffs || diffs.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-5 py-4 pr-12 border-b border-border/40">
          <GitCompareArrows className="size-4 text-muted-foreground/40" />
          <span className="text-xs font-medium text-muted-foreground">Changes</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12 min-h-[200px]">
          <FileCode2 className="size-10 text-muted-foreground/20 mb-4" />
          <p className="text-base text-muted-foreground">No changes yet</p>
          <p className="text-sm text-muted-foreground/50 mt-1.5">
            File changes will appear here as the session progresses
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <DiffSummaryBar
        diffs={diffs}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-2">
          {diffs.map((diff, i) => (
            <FileDiffCard key={`${diff.file}-${i}`} diff={diff} viewMode={viewMode} isFullscreen={isFullscreen} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
