'use client';

/**
 * One burst — a maximal run of non-text parts.
 *
 * Renders as a chain of thought: a muted summary line ("Completed 7 steps")
 * that expands into a connected vertical chain. The chain has two levels — a
 * run of consecutive same-family calls is ONE step that opens to its members,
 * so the expansion groups the work the same way the summary line counts it.
 *
 * A burst holding exactly ONE call has no summary line at all. It renders as
 * that call and nothing else: no title, no chain rail, no closing step, and no
 * leading glyph on the row (see `bare` below). "Completed 1 step" over a single
 * row is a door in front of a door.
 *
 * The trailing burst stays open for the whole working turn (so SSE gaps between
 * tool calls do not blink it shut); earlier bursts auto-collapse once later
 * text/standalone closes them. Manual after the user's first click. Collapsed
 * height is always one row.
 */

import { ChainOfThought, ChainOfThoughtStep } from '@/components/ui/chain-of-thought';
import { Disclosure, DisclosureContent } from '@/components/ui/disclosure';
import { ToolActivateContext } from '@/features/session/tool/shared/infrastructure';
import type { ConversationDensity } from '@/stores/user-preferences-store';
import { isReasoningPart, type Part } from '@/ui';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { isAnsweredQuestionPart } from './answered-question-step';
import { StepBody } from './burst-step-body';
import { burstSummary, burstSummaryLabel } from './burst-summary';
import { BurstSummaryTrigger } from './burst-summary-trigger';
import { mergeBurstSteps, reasoningIsRunning } from './merge-steps';
import { samePartsList } from './same-parts';
import { stepLabel } from './step-label';
import { ThoughtChainStep } from './thought-chain-step';
export { ActivityGroupStep, sameActivityGroupStepProps } from './activity-group-step';

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
    if (isReasoningPart(part)) return reasoningIsRunning(part);
    return false;
  });
}

export function burstFailureCount(parts: ReadonlyArray<Part>): number {
  return burstSummary(parts).failed;
}

/**
 * A burst of ONE call has nothing to summarise, so it drops the summary line
 * and IS its row.
 *
 * "Completed 1 step" is a door in front of a door: the reader clicks a line
 * that names no tool, no file and no command, to reveal the one row that names
 * all three — and that row already opens on its own. Two clicks and a
 * content-free label to reach what a single row was always going to say.
 *
 * `summary.total === 1` is what makes this safe, not `steps.length === 1`
 * alone: a group row is ONE row over N calls, and "Completed 3 steps" is
 * information the bare row does not carry.
 *
 * A lone thought qualifies too, now that `ThoughtChainStep` gives reasoning a
 * label and a caret of its own. It did not while the thought was unlabelled
 * prose: unwrapping THAT would have pinned the model's reasoning open with
 * nothing left to close it.
 *
 * `bare` drops the summary line, and with it the row's leading glyph. It
 * does not, on its own, decide that a row has no thread — a lone sub-agent is
 * one row here and a whole nested list of steps one level down, so
 * `ActivityStep` keeps a delegate row's icon even when bare, and keeps a
 * failed row's outcome mark. See the `hideIcon` note there.
 *
 * No rows, no burst. `mergeBurstSteps` drops plumbing outright (memory writes,
 * context compaction) and skips blank reasoning fragments, so a run made only
 * of those merges to nothing — and the burst used to draw a summary line
 * ("Housekeeping", or "Worked" with no plumbing) over an empty chain. A
 * disclosure the reader can open onto nothing is worse than silence: it
 * advertises work it cannot show, and the caret promises a body that is not
 * there.
 *
 * The test is `steps`, not `parts`: `parts.length > 0` is exactly the case
 * that produced the empty row, because every one of those parts was filtered
 * out downstream. `steps` IS the list the chain below maps over, so this
 * cannot drift from what renders.
 */
function ActivityBurstImpl({
  parts,
  sessionId,
  working,
  isTrailing = false,
  disableNavigation,
  density = 'normal',
}: {
  parts: Part[];
  sessionId: string;
  working: boolean;
  /** Last segment in the turn — stay open across SSE gaps between tool calls. */
  isTrailing?: boolean;
  disableNavigation?: boolean;
  /**
   * User preference (`conversationDensity` in the user-preferences store),
   * passed in by the chat surface rather than read here so this component
   * stays pure and testable under `renderToStaticMarkup`.
   *
   * 'normal' — the burst opens itself while it runs: steps and streaming
   * thinking appear live. 'minimal' — the live view is the one-line summary
   * ("Working · N steps"); nothing auto-expands, including the thought rows
   * a bare burst pins open. A finished turn renders identically in both
   * modes (both auto-collapse to one row), and a click always wins.
   */
  density?: ConversationDensity;
}) {
  const running = burstIsRunning(parts, working, isTrailing);
  const autoExpand = density !== 'minimal';
  const [open, setOpen] = useState(autoExpand && running);
  const userToggled = useRef(false);

  // Auto-collapse the moment the burst settles — unless the user has taken
  // control, in which case their choice wins permanently. Under minimal
  // density the burst never opens itself in the first place.
  useEffect(() => {
    if (userToggled.current) return;
    setOpen(autoExpand && running);
  }, [running, autoExpand]);

  const steps = useMemo(() => {
    const merged = mergeBurstSteps(parts, (p) => stepLabel(p).tier);
    // An answered question owns its row's disclosure (`AnsweredQuestionStep`
    // binds trigger + content to the step's own `Disclosure`), so it can never
    // share a group row with siblings — `groupSteps` buckets `question` into
    // the `ask` family, and two disclosures in one step means one is silently
    // dropped. Split such a group back into individual part rows.
    return merged.flatMap((step) =>
      step.kind === 'group' && step.step.parts.some(isAnsweredQuestionPart)
        ? step.step.parts.map((part) => ({ kind: 'part' as const, key: part.id, part }))
        : [step],
    );
  }, [parts]);
  const summary = useMemo(() => burstSummary(parts), [parts]);
  // The summary goes through unchanged: `burstSummaryLabel` already ignores
  // failures while running, so the "no failure count mid-flight" rule lives in
  // one place rather than being re-applied by every caller.
  const title = burstSummaryLabel(summary, running);

  const bare = steps.length === 1 && summary.total === 1;
  if (steps.length === 0) return null;

  return (
    <Disclosure
      // Bare is permanently open — there is no trigger to close it with.
      open={bare || open}
      onOpenChange={(next) => {
        userToggled.current = true;
        setOpen(next);
      }}
      className="group/burst flex-row"
    >
      <BurstSummaryTrigger bare={bare} running={running} title={title} />

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
          {/* `mt-3` is the gap under the summary line. Bare has no summary
					    line, so it has no gap to open. */}
          <div className={bare ? undefined : 'mt-3'}>
            <ChainOfThought>
              {/* A thought row IS a `ChainOfThoughtStep` — it owns the step's
							    open state so it can open itself while the model thinks. */}
              {steps.map((step) =>
                step.kind === 'thought' ? (
                  /* `step.running`, not the burst's — a trailing burst reports
                     running for the whole turn by design, so passing that flag
                     down made every thought the turn ever emitted shimmer and
                     force its paragraph open. Still gated on the burst: once
                     the turn stops working, nothing in it is live, whatever a
                     part's timestamps say. */
                  <ThoughtChainStep
                    key={step.key}
                    texts={step.texts}
                    running={running && step.running}
                    durationMs={step.durationMs}
                    bare={bare}
                    autoOpen={autoExpand}
                  />
                ) : (
                  <ChainOfThoughtStep key={step.key}>
                    <StepBody
                      step={step}
                      bareRow={bare}
                      running={running}
                      sessionId={sessionId}
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

export const ActivityBurst = memo(
  ActivityBurstImpl,
  (a, b) =>
    a.sessionId === b.sessionId &&
    a.working === b.working &&
    a.isTrailing === b.isTrailing &&
    a.disableNavigation === b.disableNavigation &&
    a.density === b.density &&
    samePartsList(a.parts, b.parts),
);
ActivityBurst.displayName = 'ActivityBurst';
