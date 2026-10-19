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

import { Disclosure, DisclosureContent } from '../../components/ui/disclosure';
import { workedForLabel } from '@kortix/sdk';
import { createContext, type ReactNode } from 'react';
import { BurstSummaryTrigger } from './burst-summary-trigger';

/**
 * True under a "Worked for" row. Each burst there keeps its own closed line,
 * worded as what it did ("Ran 9 commands, read 2 files"), so the opened row
 * reads like the agent's narration with one line of work between sentences.
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
  return (
    <Disclosure className="group/work">
      <BurstSummaryTrigger scope="work" bare={false} running={false} title={workedForLabel(durationMs)} />
      <DisclosureContent>
        <WorkFoldContext.Provider value>
          {/* `mt-3` is the gap under the row. */}
          <div className="mt-3 space-y-3">{children}</div>
        </WorkFoldContext.Provider>
      </DisclosureContent>
    </Disclosure>
  );
}
