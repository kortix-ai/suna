'use client';

import { useTranslations } from 'next-intl';

import { DiffView } from '@/components/diff/diff-view';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { DiffStat, STATUS_TEXT, StatusBadge } from '@/components/ui/status';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { cn } from '@/lib/utils';
import type { ApplyPatchFile, FileDiff } from '@/ui/types';
import { useRuntimeMessages, useRuntimeSessionDiff } from '@kortix/sdk/react';
import {
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  ColumnsIcon as Columns2,
  FileCodeIcon as FileCode2,
  NotePencilIcon as FileEdit,
  FilePlusIcon as FilePlus2,
  FileXIcon as FileX2,
  GitDiffIcon as GitCompareArrows,
  ArrowsOutSimpleIcon as Maximize2,
  ArrowsInSimpleIcon as Minimize2,
  RowsIcon as Rows2,
} from '@phosphor-icons/react';
import { createTwoFilesPatch } from 'diff';
import { useMemo, useState } from 'react';

// ============================================================================
// Single file diff card
// ============================================================================

function FileDiffCard({
  diff,
  viewMode,
  isFullscreen,
}: {
  diff: FileDiff;
  viewMode: 'unified' | 'split';
  isFullscreen?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = useMemo(() => {
    switch (diff.status) {
      case 'added':
        return <FilePlus2 className={cn('size-3.5', STATUS_TEXT.success)} />;
      case 'deleted':
        return <FileX2 className={cn('size-3.5', STATUS_TEXT.destructive)} />;
      default:
        return <FileEdit className={cn('size-3.5', STATUS_TEXT.info)} />;
    }
  }, [diff.status]);

  const statusLabel = useMemo(() => {
    switch (diff.status) {
      case 'added':
        return 'Added';
      case 'deleted':
        return 'Deleted';
      default:
        return 'Modified';
    }
  }, [diff.status]);

  const statusVariant = useMemo((): 'success' | 'destructive' | 'info' => {
    switch (diff.status) {
      case 'added':
        return 'success';
      case 'deleted':
        return 'destructive';
      default:
        return 'info';
    }
  }, [diff.status]);

  const patch = useMemo(() => {
    if (diff.patch) return diff.patch;
    if (!diff.before && !diff.after) return '';
    return createTwoFilesPatch(
      diff.file || '',
      diff.file || '',
      diff.before || '',
      diff.after || '',
      '',
      '',
    );
  }, [diff.file, diff.patch, diff.before, diff.after]);

  const hasDiffContent = patch.length > 0;
  const filename = diff.file?.split('/').pop() || diff.file;
  const directory = diff.file?.includes('/')
    ? diff.file?.substring(0, diff.file?.lastIndexOf('/'))
    : '';

  return (
    <div className="border-border/50 bg-card overflow-hidden rounded-md border">
      {/* File header */}
      <button
        onClick={() => hasDiffContent && setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
          hasDiffContent && 'hover:bg-muted/40 cursor-pointer',
          !hasDiffContent && 'cursor-default',
        )}
      >
        {hasDiffContent &&
          (expanded ? (
            <ChevronDown className="text-muted-foreground/50 size-3 shrink-0" />
          ) : (
            <ChevronRight className="text-muted-foreground/50 size-3 shrink-0" />
          ))}
        {!hasDiffContent && <span className="w-3" />}

        {statusIcon}

        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <span className="text-foreground truncate text-xs font-medium">{filename}</span>
          {directory && (
            <span className="text-muted-foreground/50 hidden truncate text-xs sm:inline">
              {directory}
            </span>
          )}
        </div>

        {/* Status badge */}
        <StatusBadge tone={statusVariant}>{statusLabel}</StatusBadge>

        {/* Addition/deletion counts */}
        <DiffStat
          additions={diff.additions}
          deletions={diff.deletions}
          className="shrink-0 text-xs whitespace-nowrap"
        />
      </button>

      {/* Expanded diff content */}
      {expanded && hasDiffContent && (
        <div
          className={cn(
            'border-border/40 overflow-y-auto border-t',
            isFullscreen ? 'max-h-[calc(100vh-12rem)]' : 'max-h-96',
          )}
        >
          <DiffView patch={patch} layout={viewMode} hideFileHeader />
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
  reserveCloseGutter,
}: {
  diffs: FileDiff[];
  viewMode: 'unified' | 'split';
  onViewModeChange: (mode: 'unified' | 'split') => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  reserveCloseGutter?: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const totals = useMemo(() => {
    let additions = 0,
      deletions = 0,
      added = 0,
      deleted = 0,
      modified = 0;
    for (const d of diffs) {
      additions += d.additions;
      deletions += d.deletions;
      if (d.status === 'added') added++;
      else if (d.status === 'deleted') deleted++;
      else modified++;
    }
    return { additions, deletions, added, deleted, modified };
  }, [diffs]);

  const unifiedLabel = tHardcodedUi.raw(
    'componentsSessionSessionDiffViewer.line186JsxAttrTitleUnifiedView',
  );
  const splitLabel = tHardcodedUi.raw(
    'componentsSessionSessionDiffViewer.line198JsxAttrTitleSideBySideView',
  );
  const fullscreenLabel = isFullscreen ? 'Exit fullscreen' : 'Fullscreen';

  return (
    <div
      className={cn(
        'border-border/40 bg-muted/20 flex w-full items-center gap-3 border-b px-4 py-2.5',
        // Only the modal mount has a floating close button to clear.
        reserveCloseGutter && 'pr-14',
      )}
    >
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {diffs.length} {diffs.length === 1 ? 'file' : 'files'} changed
      </span>
      <div className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap">
        {totals.added > 0 && (
          <span className={cn('flex items-center gap-1 tabular-nums', STATUS_TEXT.success)}>
            <FilePlus2 className="size-3" /> {totals.added}
          </span>
        )}
        {totals.modified > 0 && (
          <span className={cn('flex items-center gap-1 tabular-nums', STATUS_TEXT.info)}>
            <FileEdit className="size-3" /> {totals.modified}
          </span>
        )}
        {totals.deleted > 0 && (
          <span className={cn('flex items-center gap-1 tabular-nums', STATUS_TEXT.destructive)}>
            <FileX2 className="size-3" /> {totals.deleted}
          </span>
        )}
        <span className="text-muted-foreground/50 mx-1">|</span>
        <DiffStat
          additions={totals.additions}
          deletions={totals.deletions}
          className="tabular-nums"
        />

        {/* View mode toggle — a two-state group, so each control reports its
            own pressed state instead of relying on colour alone. */}
        <span className="text-muted-foreground/50 mx-1">|</span>
        <Hint label={unifiedLabel} side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={unifiedLabel}
            aria-pressed={viewMode === 'unified'}
            onClick={() => onViewModeChange('unified')}
            className={cn(
              'active:scale-[0.96]',
              viewMode === 'unified'
                ? 'text-foreground bg-muted/60'
                : 'text-muted-foreground/70 hover:text-foreground',
            )}
          >
            <Rows2 className="size-3.5" />
          </Button>
        </Hint>
        <Hint label={splitLabel} side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={splitLabel}
            aria-pressed={viewMode === 'split'}
            onClick={() => onViewModeChange('split')}
            className={cn(
              'active:scale-[0.96]',
              viewMode === 'split'
                ? 'text-foreground bg-muted/60'
                : 'text-muted-foreground/70 hover:text-foreground',
            )}
          >
            <Columns2 className="size-3.5" />
          </Button>
        </Hint>

        {/* Fullscreen toggle */}
        {onToggleFullscreen && (
          <Hint label={fullscreenLabel} side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={fullscreenLabel}
              aria-pressed={!!isFullscreen}
              onClick={onToggleFullscreen}
              className="text-muted-foreground/70 hover:text-foreground active:scale-[0.96]"
            >
              {isFullscreen ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </Button>
          </Hint>
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
  /**
   * True only where the viewer renders under a floating close button — the
   * modal mount ({@link DiffDialog}). The side-panel mount has no such button,
   * and reserving the gutter there left the toolbar floating 56px short of the
   * right edge.
   */
  reserveCloseGutter?: boolean;
}

/** Shared header for the non-content states, so all three stay identical. */
function DiffPanelHeader({ reserveCloseGutter }: { reserveCloseGutter?: boolean }) {
  return (
    <div
      className={cn(
        'border-border/40 flex items-center gap-2 border-b px-5 py-4',
        reserveCloseGutter && 'pr-14',
      )}
    >
      <GitCompareArrows className="text-muted-foreground/40 size-4" />
      <span className="text-muted-foreground text-xs font-medium">Changes</span>
    </div>
  );
}

export function SessionDiffViewer({
  sessionId,
  isFullscreen,
  onToggleFullscreen,
  reserveCloseGutter,
}: SessionDiffViewerProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: apiDiffs, isLoading, error, refetch } = useRuntimeSessionDiff(sessionId);
  const { data: messages } = useRuntimeMessages(sessionId);
  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified');

  // Fall back to extracting diffs from tool part metadata when the API returns empty
  const messageDiffs = useMemo(() => extractDiffsFromMessages(messages as any), [messages]);

  const diffs = apiDiffs && apiDiffs.length > 0 ? apiDiffs : messageDiffs;

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <DiffPanelHeader reserveCloseGutter={reserveCloseGutter} />
        {/* Shape-matched to the file rows below and anchored to the top, so
            content does not jump up from the middle of the pane on load. */}
        <div className="min-h-0 flex-1 space-y-2 p-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full py-0" />
          ))}
        </div>
      </div>
    );
  }

  if (error && diffs.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <DiffPanelHeader reserveCloseGutter={reserveCloseGutter} />
        <ErrorState
          size="sm"
          className="min-h-0 flex-1"
          title={tHardcodedUi.raw(
            'componentsSessionSessionDiffViewer.line355JsxTextFailedToLoadChanges',
          )}
          action={
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  if (!diffs || diffs.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <DiffPanelHeader reserveCloseGutter={reserveCloseGutter} />
        <EmptyState
          icon={FileCode2}
          className="min-h-0 flex-1"
          title={tHardcodedUi.raw('componentsSessionSessionDiffViewer.line370JsxTextNoChangesYet')}
          description={tHardcodedUi.raw(
            'componentsSessionSessionDiffViewer.line372JsxTextFileChangesWillAppearHereAsTheSession',
          )}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <DiffSummaryBar
        diffs={diffs}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
        reserveCloseGutter={reserveCloseGutter}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {diffs.map((diff) => (
            <FileDiffCard
              key={diff.file}
              diff={diff}
              viewMode={viewMode}
              isFullscreen={isFullscreen}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
