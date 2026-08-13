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

import { CaretRightIcon, CircleDashedIcon, WarningIcon } from '@phosphor-icons/react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ChainOfThought, ChainOfThoughtStep } from '@/components/ui/chain-of-thought';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { STATUS_TEXT } from '@/components/ui/status';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { ToolActivateContext } from '@/features/session/tool/shared/infrastructure';
import { cn } from '@/lib/utils';
import type { ConversationDensity } from '@/stores/user-preferences-store';
import { isReasoningPart, isToolPart, type Part } from '@/ui';
import type { Step } from '../action-panel/shared/group-steps';
import { normalizeActivityToolName } from '../session-activity-groups';
import { ActivityFileChipStep, isFileChipPart } from './activity-file-chips';
import { ActivityStep, iconFor } from './activity-step';
import { burstSummary, burstSummaryLabel } from './burst-summary';
import { flattenThought, mergeBurstSteps, reasoningIsRunning } from './merge-steps';
import { samePartsList } from './same-parts';
import { stepLabel } from './step-label';

const THOUGHT_MAX_H = 'max-h-54';

/**
 * Thought body: the model's reasoning, capped and faded.
 *
 * There is no Show more / Show less. The cap is not a collapse — it is a
 * BOUND, and a bound needs no control: the reader opened a burst to see what
 * the agent did, not to negotiate with a paragraph. The pair of buttons cost a
 * whole overflow-measurement rig (`canExpand`, a `ResizeObserver`, a resize
 * listener, a second render branch) and bought a row of chrome under a block
 * that already fades to say "there is more" and already scrolls to reach it.
 *
 * While the model is still thinking the newest words are pinned into view.
 * Without it the reader is held at the top of a paragraph that keeps growing
 * underneath the fade — the one moment the cap would actively hide the part
 * worth reading.
 */
function ThoughtStepBody({ texts, running }: { texts: ReadonlyArray<string>; running: boolean }) {
  const text = flattenThought(texts);
  const scrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [running, text]);

  return (
    <div className="min-w-0 flex-1">
      <FadedScrollArea
        ref={scrollRef}
        fadeColor="from-background"
        rootClassName={cn('h-auto', THOUGHT_MAX_H)}
        className={THOUGHT_MAX_H}
      >
        <p className="text-foreground/60 text-sm leading-[1.5] text-pretty">{text}</p>
      </FadedScrollArea>
    </div>
  );
}

/**
 * The model's reasoning, as a row that says so.
 *
 * The text used to render inline and unlabelled — a paragraph hanging in the
 * chain under a clock glyph, always open, with nothing naming it. That made
 * reasoning the loudest thing in a list of work, and it is the least of it: the
 * reader came to see what the agent DID.
 *
 * So it becomes a row like every other row — `Thinking`, a caret, and the text
 * behind it. This is also what retired Show more / Show less: a block that opens
 * needs no second control for opening further.
 *
 * It opens itself while the model is still thinking, because live reasoning is
 * the one time the text is worth more than the label, and closes when the run
 * settles — unless the reader has taken control, in which case their choice wins
 * permanently. Same rule, same shape, as the burst around it.
 *
 * `running` is THIS thought's own state, never the burst's. A trailing burst
 * reports running for the whole working turn on purpose — that is what stops
 * the disclosure blinking shut in the gaps between SSE tool calls — so a
 * burst-wide flag here made every thought in the turn shimmer at once and
 * unfurl reasoning that closed twenty steps ago. `mergeBurstSteps` decides.
 *
 * `bare` — this thought IS the whole burst — drops the glyph for the reason
 * every bare row does: the icon is the rail's anchor, and one row has no rail.
 */
function ThoughtChainStepImpl({
  texts,
  running,
  bare,
  autoOpen = true,
}: {
  texts: ReadonlyArray<string>;
  running: boolean;
  bare?: boolean;
  /**
   * Whether live reasoning may unfurl its paragraph on its own. `false` under
   * minimal density: the row still shimmers `Thinking`, but the streaming
   * text stays behind the caret until the reader asks for it. Their click
   * still wins permanently, exactly as under normal density.
   */
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen && running);
  const userToggled = useRef(false);

  useEffect(() => {
    if (userToggled.current) return;
    setOpen(autoOpen && running);
  }, [running, autoOpen]);

  return (
    <ChainOfThoughtStep
      open={open}
      onOpenChange={(next) => {
        userToggled.current = true;
        setOpen(next);
      }}
    >
      {/* Trigger + content must be ONE child, not two siblings.
			    `React.Children.toArray` flattens arrays but not fragments, and
			    `Disclosure` renders exactly slots [0] and [1] — the step's rail
			    already holds slot 0, so as siblings the trigger takes slot 1 and the
			    content is silently dropped. `ActivityGroupStep` wraps for the same
			    reason. */}
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
            {!bare && <CircleDashedIcon className="text-muted-foreground size-4 flex-none" />}
            {running ? (
              <TextShimmer className="leading-[1.5] font-medium">Thinking</TextShimmer>
            ) : (
              <span className="font-medium">Thinking</span>
            )}
            <CaretRightIcon
              className={cn(
                'text-muted-foreground/40 size-3.5 flex-none',
                'transition-transform group-data-[state=open]/step:rotate-90',
              )}
            />
          </div>
        </DisclosureTrigger>
        <DisclosureContent>
          <div className="mt-3 pl-7">
            <ThoughtStepBody texts={texts} running={running} />
          </div>
        </DisclosureContent>
      </>
    </ChainOfThoughtStep>
  );
}

/**
 * A run of consecutive same-family calls: one summary row that opens to its
 * members.
 *
 * This is the level the burst has always grouped at. Until this row existed,
 * expanding a burst of two reads and two commands produced four flat siblings —
 * the burst counted a grouped story and the expansion told an ungrouped one.
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
 *
 * The group row is the PARENT of the rows it opens, and says so without colour:
 * `font-medium` against the regular-weight tool titles underneath it (see
 * `InlineTriggerTitle` in tool/shared/infrastructure.tsx). Indent alone left the
 * two levels reading as one list at a glance.
 *
 * `step.status` is consumed here, not discarded. `groupSteps` already picks the
 * WORDS — a group holding a failure gets `narrateFailedStep`, never success
 * wording — but the row used to render the same muted glyph either way, so the
 * only failure signal inside an open burst was the sentence, and a reader had to
 * click one level deeper to find out anything had gone wrong.
 *
 * Failure REPLACES the family glyph rather than sitting beside it, the same call
 * `ToolOutcomeIcon` makes one level down: the row has one 16px gutter, and what
 * the reader needs from it is the verdict — the family is still spelled out in
 * the words immediately to its right ("Couldn't read your files"). Shape carries
 * it as much as colour, so the mark survives a reader who cannot see the red.
 *
 * Running shimmers the label, which is how every tool row in this same chain
 * already says "still going" — one running vocabulary per surface, not two.
 */
function ActivityGroupStepImpl({
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
  const failed = step.status === 'error';
  const Icon = iconFor(step.parts[0]);

  return (
    <>
      {/* One child only — DisclosureTrigger clones each child into its own
			    clickable node, so a sibling caret would stack as a separate row. */}
      <DisclosureTrigger>
        <div
          data-status={step.status}
          className={cn(
            'text-foreground/80 hover:text-foreground',
            'flex w-full cursor-pointer items-center gap-3',
            'text-left text-sm leading-[1.5] transition-colors',
          )}
        >
          {failed ? (
            <>
              {/* Closed: failure mark replaces the family glyph. Open: the
							    member rows carry their own verdicts, so the trigger falls
							    back to the family icon and drops the duplicate warning. */}
              <WarningIcon
                weight="fill"
                aria-label="This step failed"
                className={cn(
                  'size-4 flex-none group-data-[state=open]/step:hidden',
                  STATUS_TEXT.destructive,
                )}
              />
              <Icon className="text-muted-foreground hidden size-4 flex-none group-data-[state=open]/step:block" />
            </>
          ) : (
            <Icon className="text-muted-foreground size-4 flex-none" />
          )}
          {step.status === 'running' ? (
            <TextShimmer className="min-w-0 truncate leading-[1.5] font-medium">
              {step.label}
            </TextShimmer>
          ) : (
            <span className="min-w-0 truncate font-medium">{step.label}</span>
          )}
          <CaretRightIcon
            className={cn(
              'text-muted-foreground/40 size-3.5 flex-none',
              'transition-transform group-data-[state=open]/step:rotate-90',
            )}
          />
        </div>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="mt-3 space-y-3 pl-7">
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
    if (isReasoningPart(part)) return reasoningIsRunning(part);
    return false;
  });
}

export function burstFailureCount(parts: ReadonlyArray<Part>): number {
  return burstSummary(parts).failed;
}

/**
 * True when this run is entirely one file family, so it can render as chips.
 *
 * `isFileChipPart` alone is not enough at a group row. `groupSteps` buckets by
 * NARRATION family, and `explore` holds `glob`/`grep`/`list` beside `read`
 * while `edit` holds `edit`/`apply_patch` beside `write` — so a run of two
 * reads and a grep arrives here as one group. Requiring the same normalized
 * tool name throughout keeps a grep out of a row whose only vocabulary is
 * files, and keeps `edit`/`apply_patch` on their diff renderer.
 */
function isFileChipRun(parts: ReadonlyArray<Part>): boolean {
  const first = parts[0];
  if (!first || !isToolPart(first) || !isFileChipPart(first)) return false;
  const name = normalizeActivityToolName(first.tool);
  return parts.every(
    (part) =>
      isToolPart(part) && isFileChipPart(part) && normalizeActivityToolName(part.tool) === name,
  );
}

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

  const steps = useMemo(() => mergeBurstSteps(parts, (p) => stepLabel(p).tier), [parts]);
  const summary = useMemo(() => burstSummary(parts), [parts]);
  // The summary goes through unchanged: `burstSummaryLabel` already ignores
  // failures while running, so the "no failure count mid-flight" rule lives in
  // one place rather than being re-applied by every caller.
  const title = burstSummaryLabel(summary, running);
  const failures = running ? 0 : summary.failed;

  /**
   * One step's body, without the chain wrapper.
   *
   * Shared by the chain and by the bare single-step burst, so the two can never
   * draw the same row two different ways.
   *
   * `bare` is not styling — it says the row is the ONLY thing here, which is
   * what makes the leading glyph pointless (see `ActivityStep`).
   */
  const stepBody = (
    step: Exclude<(typeof steps)[number], { kind: 'thought' }>,
    bareRow = false,
  ) => {
    if (step.kind === 'group') {
      // Files, not tool cards, when the whole run is reads or writes. The choice
      // is made here rather than in `mergeBurstSteps` so the merge module stays
      // pure and its unwrap-a-run-of-one rule is untouched — which is also why
      // the single-part branch below can reach the same row.
      return isFileChipRun(step.step.parts) ? (
        <ActivityFileChipStep
          parts={step.step.parts}
          running={running}
          sessionId={sessionId}
          disableNavigation={disableNavigation}
        />
      ) : (
        <ActivityGroupStep
          step={step.step}
          sessionId={sessionId}
          running={running}
          disableNavigation={disableNavigation}
        />
      );
    }
    // A run of one read is unwrapped into a flat row by `mergeBurstSteps`, which
    // is right for a shell command and wrong here: one file is still a file.
    if (isFileChipPart(step.part)) {
      return (
        <ActivityFileChipStep
          parts={[step.part]}
          bare={bareRow}
          running={running}
          sessionId={sessionId}
          disableNavigation={disableNavigation}
        />
      );
    }
    return (
      <ActivityStep
        part={step.part}
        bare={bareRow}
        sessionId={sessionId}
        running={running}
        disableNavigation={disableNavigation}
      />
    );
  };

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
   */
  const bare = steps.length === 1 && summary.total === 1;

  /**
   * No rows, no burst.
   *
   * `mergeBurstSteps` drops plumbing outright (memory writes, context
   * compaction) and skips blank reasoning fragments, so a run made only of
   * those merges to nothing — and the burst used to draw a summary line
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
      {/* Summary line. Muted against the primary-weight step text below it, so
			    the eye lands on the work rather than the label for the work. The
			    caret trails the title instead of leading it — a leading glyph would
			    sit in the same gutter the step icons occupy and read as a step. */}
      {/* One child only: DisclosureTrigger clones each child into its own
			    clickable node, so title + caret as siblings stack as separate rows. */}
      {/* Slot 0 stays a `DisclosureTrigger` even when bare, and slot 1 stays a
          `DisclosureContent`. A burst grows from 1 step to 2 mid-stream, and
          React tears down a subtree whose element type changes at the same
          position — which would snap shut a row the reader had just opened and
          throw away the tool renderer's own scroll state. So bare swaps the
          trigger's CONTENTS for an empty node, never the node itself. */}
      <DisclosureTrigger className="select-none">
        {bare ? (
          <div className="hidden" aria-hidden />
        ) : (
          <div
            className={cn(
              'text-muted-foreground/70 hover:text-muted-foreground',
              'flex w-full cursor-pointer items-center gap-2',
              'text-left text-sm transition-colors',
            )}
          >
            {/* Shimmer while the burst works, which is how every row inside it
  						    already says "still going" — one running vocabulary per surface. */}
            {/* The ramp is pinned to `--muted-foreground`: `TextShimmer` sets
                `text-transparent` and paints its own hard-coded `#a1a1aa`→`#000`
                (`text-shimmer.tsx`), discarding the inherited muted tone — at the
                sweep peak this label would be the highest-contrast text in the
                burst, above the `text-foreground/80` rows it names, inverting the
                hierarchy the comment above sets out. The `dark:` twins are not
                redundant: `text-shimmer.tsx` sets them, so an unmatched override
                loses in dark mode. `tabular-nums` on both branches because the
                count increments live during a run. */}
            {running ? (
              <TextShimmer
                className={cn(
                  'min-w-0 truncate tabular-nums',
                  '[--base-color:color-mix(in_oklch,var(--muted-foreground)_55%,transparent)] [--base-gradient-color:var(--muted-foreground)]',
                  'dark:[--base-color:color-mix(in_oklch,var(--muted-foreground)_55%,transparent)] dark:[--base-gradient-color:var(--muted-foreground)]',
                )}
              >
                {title}
              </TextShimmer>
            ) : (
              <span className="min-w-0 truncate tabular-nums">{title}</span>
            )}
            {/* The title now states the failure in words ("· 1 failed"), so this
  					    mark is the SHAPE half of that signal — what a reader who cannot see
  					    the destructive tint gets, and what survives a truncated title. It is
  					    the same glyph the failed row carries inside; it sits before the caret
  					    so the caret keeps its job as the affordance. Hidden while open — the
  					    chain body (failed rows + closing step) already carries the verdict. */}
            {failures > 0 && !open && (
              <WarningIcon
                weight="fill"
                aria-label={failures === 1 ? '1 step failed' : `${failures} steps failed`}
                className={cn('size-3.5 flex-none', STATUS_TEXT.destructive)}
              />
            )}
            {/* The caret answers the pointer on its own, driven by `group/burst`.
                The row's `hover:text-muted-foreground` reaches only the title, and
                the title is `text-transparent` for the whole time the burst runs —
                which, because a running burst is forced open, is the state a
                reader meets most. Without this the most-seen state of a clickable
                row has no hover response at all. */}
            <CaretRightIcon
              className={cn(
                'text-muted-foreground/40 group-hover/burst:text-muted-foreground/70 size-3.5 flex-none',
                'transition-[transform,color] group-data-[state=open]/burst:rotate-90',
              )}
            />
          </div>
        )}
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
                    bare={bare}
                    autoOpen={autoExpand}
                  />
                ) : (
                  <ChainOfThoughtStep key={step.key}>{stepBody(step, bare)}</ChainOfThoughtStep>
                ),
              )}

              {/* The closing step. It is a step, not a footer, so `ChainOfThought`
							    hands it `isLast` and the rail above it finally has somewhere to
							    land — the chain reads as terminated rather than trailing off.
							    Success is monochrome, at the same scale as every row: the cap is
							    punctuation, and a success-green check would out-weigh the work it
							    closes on every burst the reader opens.
								    Failure is the one thing that earns colour here. "Done" over a
								    burst that lost a page is a false summary of the chain it
								    terminates, and it is the LAST line the reader sees. */}
            </ChainOfThought>
          </div>
        </ToolActivateContext.Provider>
      </DisclosureContent>
    </Disclosure>
  );
}

/**
 * Memo boundaries.
 *
 * The chat re-renders the streaming turn on every SSE frame. Without a boundary
 * that means every burst in that turn, every row in every burst, and every tool
 * renderer under those rows — including shiki — runs again for parts that did
 * not change. These three are where the subtree can actually be cut.
 *
 * `ActivityBurst` compares `parts` element-wise rather than by identity, because
 * while a turn streams its segments are rebuilt each frame: the ARRAY is always
 * new, its contents almost never are. See `same-parts.ts`.
 *
 * `ActivityGroupStep` and `ThoughtChainStep` take a memoised `step` / `texts`
 * from `mergeBurstSteps`, so the default shallow compare would hold for the
 * group; `texts` is a fresh array per merge, so the thought needs the same
 * element-wise rule.
 *
 * `ChainOfThought` and `ChainOfThoughtStep` are deliberately NOT memoised: they
 * take `children`, which is a new element on every parent render, so a boundary
 * there can never hold and would only add a failed comparison.
 */
export const ActivityGroupStep = memo(ActivityGroupStepImpl);
ActivityGroupStep.displayName = 'ActivityGroupStep';

const ThoughtChainStep = memo(
  ThoughtChainStepImpl,
  (a, b) =>
    a.running === b.running &&
    a.bare === b.bare &&
    a.autoOpen === b.autoOpen &&
    samePartsList(a.texts, b.texts),
);
ThoughtChainStep.displayName = 'ThoughtChainStep';

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
