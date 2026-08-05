'use client';

/**
 * One burst — a maximal run of non-text parts.
 *
 * Renders as a chain of thought: a muted summary line that expands into a
 * connected vertical chain of steps. The chain has two levels — a run of
 * consecutive same-family calls is ONE step that opens to its members, so the
 * expansion groups the work the same way the collapsed summary line does.
 *
 * The trailing burst stays open for the whole working turn (so SSE gaps between
 * tool calls do not blink it shut); earlier bursts auto-collapse once later
 * text/standalone closes them. Manual after the user's first click. Collapsed
 * height is always one row. A settled chain closes on a "Done" step so the rail
 * terminates instead of trailing off.
 */

import {
  CaretRightIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ChainOfThought, ChainOfThoughtStep } from '@/components/ui/chain-of-thought';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { STATUS_TEXT } from '@/components/ui/status';
import { partOutcome, ToolActivateContext } from '@/features/session/tool/shared/infrastructure';
import { cn } from '@/lib/utils';
import { isReasoningPart, isToolPart, type Part } from '@/ui';
import type { Step } from '../action-panel/shared/group-steps';
import { ActivityStep, iconFor } from './activity-step';
import { burstTitle } from './burst-title';
import { flattenThought, mergeBurstSteps } from './merge-steps';
import { stepLabel } from './step-label';

const THOUGHT_COLLAPSED_MAX_H = 'max-h-54';

/**
 * Thought body: capped while collapsed (`THOUGHT_COLLAPSED_MAX_H` + fade),
 * with Show more / Show less once the text overflows the cap.
 */
function ThoughtStepBody({ texts, running }: { texts: ReadonlyArray<string>; running: boolean }) {
  const text = flattenThought(texts);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const checkOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el || expanded) return;
    setCanExpand(el.scrollHeight > el.clientHeight + 1);
  }, [expanded]);

  useLayoutEffect(() => {
    checkOverflow();
    const el = scrollRef.current;
    if (el && running && !expanded) {
      el.scrollTop = el.scrollHeight;
    }
  }, [checkOverflow, expanded, running, text]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(el);
    window.addEventListener('resize', checkOverflow);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', checkOverflow);
    };
  }, [checkOverflow, text, expanded]);

  return (
    <div className="min-w-0 flex-1">
      {expanded ? (
        <p className="text-foreground/60 text-sm leading-[1.5] text-pretty">{text}</p>
      ) : (
        <FadedScrollArea
          ref={scrollRef}
          fadeColor="from-background"
          rootClassName={cn('h-auto', THOUGHT_COLLAPSED_MAX_H)}
          className={THOUGHT_COLLAPSED_MAX_H}
        >
          <p className="text-foreground/60 text-sm leading-[1.5] text-pretty">{text}</p>
        </FadedScrollArea>
      )}
      {canExpand && !running ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'text-muted-foreground hover:text-foreground mt-1 inline-flex cursor-pointer items-center',
            'origin-left text-xs font-medium transition-[color,transform] duration-150 ease-out active:scale-[0.96]',
            'focus-visible:ring-ring/50 rounded-sm focus-visible:ring-2 focus-visible:outline-none',
          )}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A run of consecutive same-family calls: one summary row that opens to its
 * members.
 *
 * This is the level the collapsed burst title has always described. The title
 * says "Read 2 files, ran 2 commands" and, until this row existed, expanding it
 * produced four flat siblings — the summary grouped and the expansion did not.
 *
 * The group binds to `ChainOfThoughtStep`'s OWN `Disclosure`, so it opens
 * independently of every other step and the chain rail still spans it however
 * tall it grows. Trigger and content must be one component rather than two
 * sibling children of the step: `Disclosure` renders exactly
 * `React.Children.toArray(children)[0]` and `[1]`, and the step's rail already
 * claims slot 0 — passing them as siblings would silently drop the content.
 *
 * `pl-7` puts the members under the group's LABEL (size-4 icon + gap-3), clear
 * of the rail at `left-2` — the indent is what says these rows belong to the
 * row above rather than to the chain.
 */
export function ActivityGroupStep({
  step,
  sessionId,
  running,
  disableNavigation,
}: {
  step: Step;
  sessionId: string;
  running: boolean;
  disableNavigation?: boolean;
}) {
  const Icon = iconFor(step.parts[0]);

  return (
    <>
      {/* One child only — DisclosureTrigger clones each child into its own
			    clickable node, so a sibling caret would stack as a separate row. */}
      <DisclosureTrigger>
        <div
          className={cn(
            'text-foreground/80 hover:text-foreground',
            'flex w-full cursor-pointer items-center gap-3',
            'text-left text-sm leading-[1.5] transition-colors',
          )}
        >
          <Icon className="text-muted-foreground size-4 flex-none" />
          <span className="min-w-0 truncate">{step.label}</span>
          <CaretRightIcon
            className={cn(
              'text-muted-foreground/40 size-3.5 flex-none',
              'transition-transform group-data-[state=open]/step:rotate-90',
            )}
          />
        </div>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="mt-2 space-y-2 pl-7">
          {step.parts.map((part) => (
            <ActivityStep
              key={part.id}
              part={part}
              sessionId={sessionId}
              running={running}
              disableNavigation={disableNavigation}
            />
          ))}
        </div>
      </DisclosureContent>
    </>
  );
}

/**
 * True when this burst should stay open as "in progress".
 *
 * - Turn idle → closed.
 * - Trailing burst while the turn still works → open. Tool parts often settle
 *   for a beat before the next SSE call arrives; treating that gap as settled
 *   blinks the disclosure shut between every pair of calls.
 * - Non-trailing burst → open only while it still has an unfinished part
 *   (later text/standalone already closed this run).
 */
export function burstIsRunning(
  parts: ReadonlyArray<Part>,
  working: boolean,
  isTrailing = false,
): boolean {
  if (!working) return false;
  if (isTrailing) return true;
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

/**
 * True when the chain gets its closing step.
 *
 * Two clauses, both about not lying to the reader:
 *   - A running burst has no cap. The open end IS the signal that more is
 *     coming; capping it would claim the work finished while it is mid-flight.
 *   - An empty chain has no cap. When every part was plumbing the body renders
 *     nothing, and a lone cap with no steps above it terminates nothing.
 */
export function showsClosingStep(stepCount: number, running: boolean): boolean {
  return stepCount > 0 && !running;
}

/**
 * How many tool calls in this burst failed or half-failed.
 *
 * The cap used to read "Done" for every settled burst, including one whose only
 * step was a dead host — so the chain closed by asserting success over a
 * failure the reader had to expand a card to find. Reasoning parts are not
 * counted: a thought has no verdict to report.
 */
export function burstFailureCount(parts: ReadonlyArray<Part>): number {
  return parts.filter((part) => isToolPart(part) && partOutcome(part) !== 'ok').length;
}

export function ActivityBurst({
  parts,
  sessionId,
  working,
  isTrailing = false,
  disableNavigation,
}: {
  parts: Part[];
  sessionId: string;
  working: boolean;
  /** Last segment in the turn — stay open across SSE gaps between tool calls. */
  isTrailing?: boolean;
  disableNavigation?: boolean;
}) {
  const running = burstIsRunning(parts, working, isTrailing);
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
  const failures = useMemo(() => (running ? 0 : burstFailureCount(parts)), [parts, running]);

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
            'text-muted-foreground/70 hover:text-muted-foreground',
            'flex w-full cursor-pointer items-center gap-1.5',
            'text-left text-sm transition-colors',
          )}
        >
          <span className="min-w-0 truncate">{title}</span>
          {/* A settled burst collapses itself, so without this mark a failed
					    step is reachable only by a reader who happens to expand a line
					    that reads "Scraped 1 page". The glyph is the same one the failed
					    row carries inside; it sits before the caret so the caret keeps
					    its job as the affordance. */}
          {failures > 0 && (
            <WarningIcon
              weight="fill"
              aria-label={failures === 1 ? '1 step failed' : `${failures} steps failed`}
              className={cn('size-3.5 flex-none', STATUS_TEXT.destructive)}
            />
          )}
          <CaretRightIcon
            className={cn(
              'text-muted-foreground/40 size-3.5 flex-none',
              'transition-transform group-data-[state=open]/burst:rotate-90',
            )}
          />
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
              {steps.map((step) => {
                if (step.kind === 'thought') {
                  return (
                    <ChainOfThoughtStep key={step.key}>
                      <div className="flex min-w-0 gap-3">
                        <ClockCounterClockwiseIcon className="text-muted-foreground mt-[3px] size-4 flex-none" />
                        <ThoughtStepBody texts={step.texts} running={running} />
                      </div>
                    </ChainOfThoughtStep>
                  );
                }
                if (step.kind === 'group') {
                  return (
                    <ChainOfThoughtStep key={step.key}>
                      <ActivityGroupStep
                        step={step.step}
                        sessionId={sessionId}
                        running={running}
                        disableNavigation={disableNavigation}
                      />
                    </ChainOfThoughtStep>
                  );
                }
                return (
                  <ChainOfThoughtStep key={step.key}>
                    <ActivityStep
                      part={step.part}
                      sessionId={sessionId}
                      running={running}
                      disableNavigation={disableNavigation}
                    />
                  </ChainOfThoughtStep>
                );
              })}

              {/* The closing step. It is a step, not a footer, so `ChainOfThought`
							    hands it `isLast` and the rail above it finally has somewhere to
							    land — the chain reads as terminated rather than trailing off.
							    Success is monochrome, at the same scale as every row: the cap is
							    punctuation, and a success-green check would out-weigh the work it
							    closes on every burst the reader opens.
								    Failure is the one thing that earns colour here. "Done" over a
								    burst that lost a page is a false summary of the chain it
								    terminates, and it is the LAST line the reader sees. */}
              {showsClosingStep(steps.length, running) && (
                <ChainOfThoughtStep key="done">
                  <div className="flex min-w-0 items-center gap-3">
                    {failures > 0 ? (
                      <>
                        <WarningIcon
                          weight="fill"
                          className={cn('size-4 flex-none', STATUS_TEXT.destructive)}
                        />
                        <span className="text-muted-foreground text-sm leading-[1.5]">
                          {failures === 1 ? '1 step failed' : `${failures} steps failed`}
                        </span>
                      </>
                    ) : (
                      <>
                        <CheckCircleIcon
                          weight="fill"
                          className="text-muted-foreground size-4 flex-none"
                        />
                        <span className="text-muted-foreground text-sm leading-[1.5]">Done</span>
                      </>
                    )}
                  </div>
                </ChainOfThoughtStep>
              )}
            </ChainOfThought>
          </div>
        </ToolActivateContext.Provider>
      </DisclosureContent>
    </Disclosure>
  );
}
