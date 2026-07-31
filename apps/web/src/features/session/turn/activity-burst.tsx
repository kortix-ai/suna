'use client';

/**
 * One burst — a maximal run of non-text parts.
 *
 * Renders as a chain of thought: a muted summary line that expands into a
 * connected vertical chain of steps. Open while it streams, auto-collapsed the
 * moment it settles, and manual after the user's first click. Collapsed height
 * is always one row, whatever the burst contains.
 */

import { CaretRightIcon, ClockCounterClockwiseIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ChainOfThought, ChainOfThoughtStep } from '@/components/ui/chain-of-thought';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Loading from '@/components/ui/loading';
import { ToolActivateContext } from '@/features/session/tool/shared/infrastructure';
import { cn } from '@/lib/utils';
import { isReasoningPart, type Part } from '@/ui';
import { ActivityStep } from './activity-step';
import { burstTitle } from './burst-title';
import { flattenThought, mergeBurstSteps } from './merge-steps';
import { stepLabel } from './step-label';

/** True when the turn is working AND this burst has an unfinished part. */
export function burstIsRunning(parts: ReadonlyArray<Part>, working: boolean): boolean {
  if (!working) return false;
  return parts.some((part) => {
    const state = (part as { state?: { status?: string } }).state;
    if (state?.status === 'pending' || state?.status === 'running') return true;
    if (isReasoningPart(part)) {
      const end = (part as { time?: { end?: number } }).time?.end;
      return !(typeof end === 'number' && end > 0);
    }
    return false;
  });
}

export function ActivityBurst({
  parts,
  sessionId,
  working,
  disableNavigation,
}: {
  parts: Part[];
  sessionId: string;
  working: boolean;
  disableNavigation?: boolean;
}) {
  const running = burstIsRunning(parts, working);
  const [open, setOpen] = useState(running);
  const userToggled = useRef(false);

  // Auto-collapse the moment the burst settles — unless the user has taken
  // control, in which case their choice wins permanently.
  useEffect(() => {
    if (userToggled.current) return;
    setOpen(running);
  }, [running]);

  const steps = useMemo(() => mergeBurstSteps(parts, (p) => stepLabel(p).tier), [parts]);
  const title = useMemo(() => burstTitle(parts, running), [parts, running]);

  if (parts.length === 0) return null;

  return (
    <Disclosure
      open={open}
      onOpenChange={(next) => {
        userToggled.current = true;
        setOpen(next);
      }}
      className="group/burst flex-row"
    >
      {/* Summary line. Muted against the primary-weight step text below it, so
			    the eye lands on the work rather than the label for the work. The
			    caret trails the title instead of leading it — a leading glyph would
			    sit in the same gutter the step icons occupy and read as a step. */}
      {/* One child only: DisclosureTrigger clones each child into its own
			    clickable node, so title + caret as siblings stack as separate rows. */}
      <DisclosureTrigger>
        <div
          className={cn(
            'text-muted-foreground hover:text-foreground',
            'flex w-full cursor-pointer items-center gap-1.5',
            'text-left text-sm transition-colors',
          )}
        >
          <span className="min-w-0 truncate">{title}</span>
          <CaretRightIcon
            className={cn(
              'text-muted-foreground/40 size-3.5 flex-none',
              'transition-transform group-data-[state=open]/burst:rotate-90',
            )}
          />
          {running && <Loading className="text-muted-foreground/50 size-3 flex-none" />}
        </div>
      </DisclosureTrigger>

      <DisclosureContent>
        {/*
				  A step in a burst is a sub-step of the turn, not a doorway to the
				  side panel. `ToolActivateContext` is bound ambient-wide by the chat
				  surface so a tool row can jump straight to the Advanced panel — the
				  right behaviour for that panel's own list, wrong here: it silently
				  swapped every row's "click to expand inline" for "click to leave the
				  conversation", and painted a panel-shortcut icon on hover that meant
				  nothing to a reader who never asked to go anywhere. Null it out for
				  everything under this chain so a click always expands in place.
				*/}
        <ToolActivateContext.Provider value={null}>
          <div className="mt-3">
            <ChainOfThought>
              {steps.map((step) =>
                step.kind === 'thought' ? (
                  <ChainOfThoughtStep key={step.key}>
                    <div className="flex min-w-0 gap-3">
                      <ClockCounterClockwiseIcon className="text-muted-foreground mt-[3px] size-4 flex-none" />
                      <p className="text-foreground/90 min-w-0 flex-1 text-sm leading-[1.5] text-pretty">
                        {flattenThought(step.texts)}
                      </p>
                    </div>
                  </ChainOfThoughtStep>
                ) : (
                  <ChainOfThoughtStep key={step.key}>
                    <ActivityStep
                      part={step.part}
                      sessionId={sessionId}
                      running={running}
                      disableNavigation={disableNavigation}
                    />
                  </ChainOfThoughtStep>
                ),
              )}
            </ChainOfThought>
          </div>
        </ToolActivateContext.Provider>
      </DisclosureContent>
    </Disclosure>
  );
}
