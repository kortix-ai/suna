'use client';

/**
 * One burst — a maximal run of non-text parts.
 *
 * Open while it streams, auto-collapsed the moment it settles, and manual
 * after the user's first click. Collapsed height is always one row, whatever
 * the burst contains.
 */

import { CaretRightIcon, SparkleIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import Loading from '@/components/ui/loading';
import { Steps, StepsContent, StepsTrigger } from '@/components/ui/steps';
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
    <Steps
      open={open}
      onOpenChange={(next) => {
        userToggled.current = true;
        setOpen(next);
      }}
    >
      <StepsTrigger
        leftIcon={<SparkleIcon className="size-3.5" />}
        trailing={
          <>
            {duration && (
              <span className="text-muted-foreground/50 font-mono text-xs tabular-nums">
                {duration}
              </span>
            )}
            {running && <Loading className="text-muted-foreground/50 size-3" />}
          </>
        }
      >
        {title}
      </StepsTrigger>

      <StepsContent>
        {primary.map((part) => (
          <ActivityStep
            key={part.id}
            part={part}
            sessionId={sessionId}
            running={running}
            disableNavigation={disableNavigation}
          />
        ))}

        {/*
          Plumbing rows are never hidden — the spec is "demote everything, hide
          nothing" — but they sit behind their own disclosure so six compaction
          rows cannot drown four real ones.
        */}
        {plumbing.length > 0 && (
          <Collapsible open={plumbingOpen} onOpenChange={setPlumbingOpen}>
            <CollapsibleTrigger
              className={cn(
                'text-muted-foreground/50 hover:text-muted-foreground',
                'flex cursor-pointer items-center gap-1.5 text-xs transition-colors',
              )}
            >
              <CaretRightIcon
                className={cn('size-3 transition-transform', plumbingOpen && 'rotate-90')}
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
        )}
      </StepsContent>
    </Steps>
  );
}
