'use client';

/**
 * One burst — a maximal run of non-text parts.
 *
 * Renders as a chain of thought: a muted summary line that expands into a
 * connected vertical chain of steps, each joined to the next by a short rule.
 * Open while it streams, auto-collapsed the moment it settles, and manual
 * after the user's first click. Collapsed height is always one row, whatever
 * the burst contains.
 */

import { CaretRightIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ChainOfThought, ChainOfThoughtStep } from '@/components/ui/chain-of-thought';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { isReasoningPart, type Part } from '@/ui';
import { ActivityStep } from './activity-step';
import { burstTitle } from './burst-title';
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

function durationMs(parts: ReadonlyArray<Part>): number {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  for (const part of parts) {
    const time =
      (part as { state?: { time?: { start?: number; end?: number } } }).state?.time ??
      (part as { time?: { start?: number; end?: number } }).time;
    if (typeof time?.start === 'number' && time.start < earliest) earliest = time.start;
    if (typeof time?.end === 'number' && time.end > latest) latest = time.end;
  }
  return latest > earliest ? latest - earliest : 0;
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
  const [plumbingOpen, setPlumbingOpen] = useState(false);
  const userToggled = useRef(false);

  // Auto-collapse the moment the burst settles — unless the user has taken
  // control, in which case their choice wins permanently.
  useEffect(() => {
    if (userToggled.current) return;
    setOpen(running);
  }, [running]);

  const { primary, plumbing } = useMemo(() => {
    const primaryParts: Part[] = [];
    const plumbingParts: Part[] = [];
    for (const part of parts) {
      (stepLabel(part).tier === 'plumbing' ? plumbingParts : primaryParts).push(part);
    }
    return { primary: primaryParts, plumbing: plumbingParts };
  }, [parts]);

  const title = useMemo(() => burstTitle(parts, running), [parts, running]);
  const ms = durationMs(parts);
  const duration = !running && ms >= 1000 ? `${Math.round(ms / 1000)}s` : '';

  if (parts.length === 0) return null;

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        userToggled.current = true;
        setOpen(next);
      }}
      className="group/burst"
    >
      {/* Summary line. Muted against the primary-weight step text below it, so
			    the eye lands on the work rather than the label for the work. The
			    caret trails the title instead of leading it — a leading glyph would
			    sit in the same gutter the step icons occupy and read as a step. */}
      <CollapsibleTrigger
        className={cn(
          'text-muted-foreground hover:text-foreground',
          'flex w-full cursor-pointer items-center gap-1.5 text-left text-sm transition-colors',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {duration && (
          <span className="text-muted-foreground/50 flex-none font-mono text-xs tabular-nums">
            {duration}
          </span>
        )}
        {running && <Loading className="text-muted-foreground/50 size-3 flex-none" />}
        <CaretRightIcon
          className={cn(
            'text-muted-foreground/40 size-3.5 flex-none',
            'transition-transform group-data-[state=open]/burst:rotate-90',
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-2">
          <ChainOfThought>
            {[
              ...primary.map((part) => (
                <ChainOfThoughtStep key={part.id}>
                  <ActivityStep
                    part={part}
                    sessionId={sessionId}
                    running={running}
                    disableNavigation={disableNavigation}
                  />
                </ChainOfThoughtStep>
              )),

              /*
							  Plumbing is never hidden — the rule is "demote everything, hide
							  nothing" — but it sits behind its own disclosure as the final
							  link in the chain, so six compaction rows cannot drown four real
							  ones. It is last because it is the least interesting thing that
							  happened, not because it happened last.
							*/
              ...(plumbing.length > 0
                ? [
                    <ChainOfThoughtStep key="__plumbing__">
                      <Collapsible open={plumbingOpen} onOpenChange={setPlumbingOpen}>
                        <CollapsibleTrigger
                          className={cn(
                            'group/plumbing text-muted-foreground/50 hover:text-muted-foreground',
                            'flex cursor-pointer items-center gap-1.5 text-xs transition-colors',
                          )}
                        >
                          <CaretRightIcon
                            className={cn(
                              'size-3 flex-none transition-transform',
                              'group-data-[state=open]/plumbing:rotate-90',
                            )}
                          />
                          <span>Behind the scenes</span>
                          <span className="tabular-nums">{plumbing.length}</span>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <div className="mt-1.5 space-y-1.5 opacity-70">
                            {plumbing.map((part) => (
                              <ActivityStep
                                key={part.id}
                                part={part}
                                sessionId={sessionId}
                                running={running}
                                disableNavigation={disableNavigation}
                              />
                            ))}
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    </ChainOfThoughtStep>,
                  ]
                : []),
            ]}
          </ChainOfThought>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
