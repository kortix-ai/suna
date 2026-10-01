'use client';

import { ChainOfThoughtStep } from '@/components/ui/chain-of-thought';
import { DisclosureContent } from '@/components/ui/disclosure';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/ui';
import { CircleDashedIcon } from '@phosphor-icons/react';
import { memo, useEffect, useRef, useState } from 'react';
import { ChainStepTrigger } from './chain-step-trigger';
import { flattenThought } from './merge-steps';
import { samePartsList } from './same-parts';

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
  const pinRaf = useRef<number | null>(null);

  // One rAF per frame, not one forced-synchronous layout per SSE token.
  //
  // `el.scrollHeight` is a layout read — answering it while the model is
  // still streaming means flushing whatever layout work React's commit has
  // pending RIGHT NOW, synchronously, once per text delta. A `useLayoutEffect`
  // that reads it runs inside React's commit phase, ahead of the browser's own
  // paint, which is exactly the moment nothing else has forced that flush yet.
  // Scheduling the read+write inside `requestAnimationFrame` instead moves it
  // to the point the browser is already about to compute layout for that
  // frame's paint — the same information, at the point it was free.
  //
  // Multiple text deltas can land in the same frame (several SSE messages,
  // one React commit each) — cancelling any not-yet-run rAF before scheduling
  // a new one collapses them to the single measurement the frame actually
  // paints, rather than measuring and writing `scrollTop` once per delta.
  useEffect(() => {
    if (!running) return;
    if (pinRaf.current !== null) cancelAnimationFrame(pinRaf.current);
    pinRaf.current = requestAnimationFrame(() => {
      pinRaf.current = null;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => {
      if (pinRaf.current !== null) {
        cancelAnimationFrame(pinRaf.current);
        pinRaf.current = null;
      }
    };
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
 * Whole seconds since this row went live, or 0 when it is not.
 *
 * Measured from the client, deliberately, rather than from the part's
 * `time.start`: a transcript restored hours later carries a start timestamp
 * from the original run, and subtracting it from `Date.now()` would render
 * "Thinking for 4h". The settled label uses the provider's timestamps, where
 * the arithmetic is between two values that belong to the same run.
 *
 * One second is the resolution the label shows, so that is the tick rate.
 */
function useLiveElapsedMs(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    // Reset on the way OUT, not on the way in: a synchronous `setElapsed(0)`
    // in the effect body is a cascading render, and clearing here means a row
    // that goes live a second time starts from zero rather than showing the
    // previous run's count until its first tick.
    return () => {
      clearInterval(id);
      setElapsed(0);
    };
  }, [running]);

  return running ? elapsed : 0;
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
 * The label carries the clock. `Thinking` alone answered "the model is doing
 * something" and nothing else — no sense of whether that was two seconds or
 * ninety, which is the one question a reader waiting on a thought actually
 * has. So it counts up live (`Thinking for 12s`, measured from when this row
 * went live, not from a provider timestamp that a reload would turn into
 * nonsense) and settles on the run's real total (`Thought for 12s`, first
 * fragment's start to the last one's end).
 *
 * Sub-second thoughts stay plain `Thinking`: `formatDuration` returns '' under
 * 1000ms on purpose, and a row that says "0s" is worse than one that says
 * nothing. Same fallback covers a provider that sends no timing at all.
 *
 * `bare` — this thought IS the whole burst — drops the glyph for the reason
 * every bare row does: the icon is the rail's anchor, and one row has no rail.
 */

function ThoughtChainStepImpl({
  texts,
  running,
  durationMs,
  bare,
  autoOpen = true,
}: {
  texts: ReadonlyArray<string>;
  running: boolean;
  /** The settled run's total, from `mergeBurstSteps`. */
  durationMs?: number;
  /**
   * This thought IS the whole burst. It drops the glyph for the reason every
   * bare row does: the icon is the rail's anchor, and one row has no rail.
   */
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
  const liveElapsed = useLiveElapsedMs(running);
  const elapsed = formatDuration(running ? liveElapsed : (durationMs ?? 0));
  const label = elapsed
    ? running
      ? `Thinking for ${elapsed}`
      : `Thought for ${elapsed}`
    : 'Thinking';

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
        <ChainStepTrigger
          icon={!bare && <CircleDashedIcon className="text-muted-foreground size-4 flex-none" />}
          label={
            running ? (
              <TextShimmer className="leading-[1.5] font-medium tabular-nums">{label}</TextShimmer>
            ) : (
              <span className="font-medium tabular-nums">{label}</span>
            )
          }
        />
        <DisclosureContent>
          <div className="mt-3 pl-7">
            <ThoughtStepBody texts={texts} running={running} />
          </div>
        </DisclosureContent>
      </>
    </ChainOfThoughtStep>
  );
}

export const ThoughtChainStep = memo(
  ThoughtChainStepImpl,
  (a, b) =>
    a.running === b.running &&
    a.durationMs === b.durationMs &&
    a.bare === b.bare &&
    a.autoOpen === b.autoOpen &&
    samePartsList(a.texts, b.texts),
);
ThoughtChainStep.displayName = 'ThoughtChainStep';
