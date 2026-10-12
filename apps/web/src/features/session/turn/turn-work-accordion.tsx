'use client';

/**
 * A settled turn's work, folded behind one "Worked for 2m 14s" row (KRTX-2113).
 *
 * Mounted only once the turn has settled, always closed: a history turn paints
 * collapsed with no animation (`DisclosureContent` runs `AnimatePresence
 * initial={false}`) and mounts none of its work until the reader opens it.
 * While the turn works, `TurnToolBlocks` renders the plain stream instead;
 * wrapping it would move the final text and the deliverables to another
 * parent at settle and remount them.
 */

import { Disclosure, DisclosureContent } from '@/components/ui/disclosure';
import { workedForLabel } from '@kortix/sdk';
import { createContext, type ReactNode, useState } from 'react';
import { BurstSummaryTrigger } from './burst-summary-trigger';

/**
 * True inside a "Worked for" row the reader has opened. The row already
 * summarises the turn, so each burst under it drops its own "Completed N
 * steps" line and shows its steps directly (`ActivityBurst`).
 */
export const WorkFoldContext = createContext(false);

export function TurnWorkAccordion({
  durationMs,
  children,
}: {
  /** `sessionTurnDurationMs(turn)`; `null` reads "Worked". */
  durationMs: number | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Latched on the reader's first open, never reset: un-flattening on close
  // would collapse every burst inside the exiting copy of the 200ms fold.
  const [flat, setFlat] = useState(false);

  return (
    <Disclosure
      open={open}
      onOpenChange={(next) => {
        if (next) setFlat(true);
        setOpen(next);
      }}
      className="group/work"
    >
      <BurstSummaryTrigger scope="work" bare={false} running={false} title={workedForLabel(durationMs)} />
      <DisclosureContent>
        <WorkFoldContext.Provider value={flat}>
          {/* `mt-3` is the gap under the row. */}
          <div className="mt-3 space-y-3">{children}</div>
        </WorkFoldContext.Provider>
      </DisclosureContent>
    </Disclosure>
  );
}
