'use client';

/**
 * The turn's work, folded behind one "Worked for 2m 14s" row (KRTX-2113).
 *
 * While the turn works, the row is hidden and the content is forced open, so
 * the steps stream exactly as before. The wrapper is there anyway: when the
 * turn settles, the same `Disclosure` folds shut with its own motion and every
 * burst inside keeps its state, instead of the whole list remounting into a
 * new parent.
 *
 * A turn mounted settled (history) paints collapsed with no animation:
 * `DisclosureContent` runs `AnimatePresence initial={false}`. The reader's
 * open/close choice sticks for as long as the turn is mounted — the same
 * `userToggled` rule `ActivityBurst` uses.
 */

import { Disclosure, DisclosureContent } from '@/components/ui/disclosure';
import { workedForLabel } from '@kortix/sdk';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { BurstSummaryTrigger } from './burst-summary-trigger';

export function TurnWorkAccordion({
  working,
  durationMs,
  children,
}: {
  working: boolean;
  /** `sessionTurnDurationMs(turn)`; `null` reads "Worked". */
  durationMs: number | null;
  children: ReactNode;
}) {
  // Mounted settled (history) → closed from the first render, no animation.
  const [open, setOpen] = useState(working);
  const userToggled = useRef(false);
  // Follow `working` until the reader takes control. This MUST be a layout
  // effect — neither a render-phase adjustment nor a passive effect.
  //
  // `DisclosureContent` wraps the body in `AnimatePresence`, and an exiting
  // child is rendered from the LAST COMMITTED element (`renderedChildren` in
  // framer-motion's AnimatePresence), not the latest one. The settle render
  // also moves the final text and the hoisted cards OUT of this body into the
  // slots below it. Closing in that same render (the render-phase version
  // this replaced) froze the working-era body — final text and cards
  // included — as the exiting copy, so both copies painted for the 200ms
  // fold. Here the settle render commits open with `work` only, then this
  // closes before paint: the exiting copy holds only the work, and no frame
  // paints the settled row expanded (the reason a passive effect is wrong).
  useLayoutEffect(() => {
    if (userToggled.current) return;
    setOpen(working);
  }, [working]);

  return (
    <Disclosure
      // Working is permanently open — the trigger is hidden, so nothing can close it.
      open={working || open}
      onOpenChange={(next) => {
        userToggled.current = true;
        setOpen(next);
      }}
      className="group/work"
    >
      <BurstSummaryTrigger scope="work" bare={working} running={false} title={workedForLabel(durationMs)} />
      {/* Working, the list is the live stream: nothing in it may be clipped
          (show cards, sub-agent cards, permission prompts paint focus rings and
          shadows past their box). Settled, `overflow-hidden` returns so the
          fold clips its own height animation. */}
      <DisclosureContent className={working ? 'overflow-visible' : undefined}>
        {/* `mt-3` is the gap under the row; a hidden row opens no gap. */}
        <div className={working ? 'space-y-3' : 'mt-3 space-y-3'}>{children}</div>
      </DisclosureContent>
    </Disclosure>
  );
}
