'use client';

/**
 * What this session changed — the Changes tab, and the diff modal.
 *
 * The old toolbar read:
 *
 *     12 files changed  |  +3  M5  D4  |  +142 −18  |  [▤][▥]  [⤢]
 *
 * Four numeric groups behind literal pipe characters, three of them restating
 * what the rows underneath already showed one by one, and `M` / `D` are git
 * status letters. Underneath, every row was a bordered card carrying a status
 * icon AND a status chip AND the counts — the same fact three times per file.
 *
 * Now: the counts once, the controls, and one flat list ({@link ChangeList}) —
 * the same list the proposed-change dialog renders, so the two surfaces cannot
 * drift apart again.
 *
 * The controls are CONTENT, not a bar. This viewer's panel mount already sits
 * under {@link SessionChangesHeader}'s own `h-11` row, and a second bordered
 * bar beneath it would put back the stacked chrome that "one header row per
 * surface" removed from All files. So there is no header here: the states
 * render straight into the pane and the controls scroll with the list.
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ChangeList,
  ChangeSummary,
  DiffLayoutToggle,
  ExpandAllButton,
  entryFromVcsFile,
  useChangeExpansion,
  type ChangeEntry,
  type DiffLayout,
} from '@/features/changes';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useSessionChanges } from '@/features/session/session-changes-shared';
import { cn } from '@/lib/utils';
import { ArrowsInSimpleIcon, ArrowsOutSimpleIcon, FileDashedIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

interface SessionDiffViewerProps {
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /**
   * True only where the viewer renders under a floating close button — the
   * modal mount ({@link DiffDialog}). The panel mount has no such button, and
   * reserving the gutter there left the controls 56px short of the edge.
   */
  reserveCloseGutter?: boolean;
}

export function SessionDiffViewer({
  isFullscreen,
  onToggleFullscreen,
  reserveCloseGutter,
}: SessionDiffViewerProps) {
  // The SAME query the tab badge and the header chip count. One array, one key
  // — the body can no longer say "no changes" under a badge reading 32.
  const { files, isPending, error, refetch } = useSessionChanges();
  const [layout, setLayout] = useState<DiffLayout>('unified');

  const entries = useMemo<ChangeEntry[]>(() => files.map(entryFromVcsFile), [files]);
  const { expanded, setRow, allExpanded, toggleAll } = useChangeExpansion(entries);

  // A DISABLED query is not an empty result. While the sandbox boots, nothing
  // has been asked yet, so the honest state is "loading", not "no changes yet".
  if (isPending) {
    return (
      // Shape-matched to the rows below and anchored to the top, so content
      // does not jump up from the middle of the pane on load.
      <div className="space-y-2 p-2">
        <Skeleton className="h-4 w-28" />
        <div className="space-y-px pt-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full py-0" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        size="sm"
        className="h-full"
        title="Could not load the changes"
        action={
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={FileDashedIcon}
        size="sm"
        className="h-full"
        title="Nothing changed yet"
        description="Files the agent edits in this session show up here."
      />
    );
  }

  const fullscreenLabel = isFullscreen ? 'Exit fullscreen' : 'Fullscreen';

  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 p-2">
        <div className={cn('flex items-center gap-1.5', reserveCloseGutter && 'pr-11')}>
          <ChangeSummary entries={entries} className="min-w-0 flex-1" />
          <ExpandAllButton allExpanded={allExpanded} onToggle={toggleAll} />
          <DiffLayoutToggle layout={layout} onChange={setLayout} />
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
                  <ArrowsInSimpleIcon className="size-3.5" />
                ) : (
                  <ArrowsOutSimpleIcon className="size-3.5" />
                )}
              </Button>
            </Hint>
          )}
        </div>
        <ChangeList
          entries={entries}
          layout={layout}
          expanded={expanded}
          onRowOpenChange={setRow}
        />
      </div>
    </ScrollArea>
  );
}
