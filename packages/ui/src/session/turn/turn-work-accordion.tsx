'use client';

/**
 * The "Worked for 2m 14s" row over a settled turn's work (KRTX-2113).
 *
 * The row owns no content. `TurnToolBlocks` keeps every segment of the turn
 * in one keyed list in both states and hides the work while the row is
 * closed. Nothing remounts at settle or on a toggle: a burst the reader
 * opened stays open, a `show` iframe does not reload, and an opened row
 * reads in call order, the work between the cards and the text it led to.
 *
 * While the row is open, a full-width hairline under it marks where the
 * work starts. A closed row has no line: it is one quiet line over the answer.
 */

import { CaretRightIcon } from '@phosphor-icons/react';
import { workedForLabel } from '@kortix/sdk';
import { createContext } from 'react';
import { cn } from '../../lib/utils';

/**
 * True under a "Worked for" row. Each burst there keeps its own closed line,
 * worded as what it did ("Ran 9 commands, read 2 files"), so the opened row
 * reads like the agent's narration with one line of work between sentences.
 */
export const WorkFoldContext = createContext(false);

/**
 * Called when the reader opens or closes a disclosure in a live turn. A turn
 * the reader touched while it worked settles with its row open.
 */
export const WorkTouchContext = createContext<(() => void) | null>(null);

export function TurnWorkAccordion({
  durationMs,
  open,
  onToggle,
  contentId,
}: {
  /** `sessionTurnDurationMs(turn)`; `null` reads "Worked". */
  durationMs: number | null;
  open: boolean;
  onToggle: () => void;
  /** The id of the element that holds the work, for `aria-controls`. */
  contentId?: string;
}) {
  return (
    <div className={cn('flex items-center', open && 'border-border/60 border-b pb-2')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onClick={onToggle}
        className={cn(
          'group/work text-muted-foreground/70 hover:text-muted-foreground flex min-w-0 cursor-pointer items-center gap-2',
          'focus-visible:ring-ring/50 rounded-sm text-left text-sm transition-colors select-none focus-visible:ring-2 focus-visible:outline-none',
        )}
      >
        <span className="min-w-0 truncate tabular-nums">{workedForLabel(durationMs)}</span>
        <CaretRightIcon
          aria-hidden
          className={cn(
            'text-muted-foreground/40 group-hover/work:text-muted-foreground/70 size-3.5 flex-none transition-[transform,color]',
            open && 'rotate-90',
          )}
        />
      </button>
    </div>
  );
}
