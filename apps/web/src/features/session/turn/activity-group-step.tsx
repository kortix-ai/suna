'use client';

import { ChainOfThought, ChainOfThoughtStep } from '@/components/ui/chain-of-thought';
import { DisclosureContent } from '@/components/ui/disclosure';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { memo } from 'react';
import type { Step } from '../action-panel/shared/group-steps';
import { ActivityStep, iconFor } from './activity-step';
import { ChainStepTrigger } from './chain-step-trigger';
import { samePartsList } from './same-parts';

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
 * Failure carries NO icon of its own. `groupSteps` already picks the WORDS —
 * a group holding a failure gets `narrateFailedStep` ("Couldn't read your
 * files"), never success wording — and the sentence is the whole signal. The
 * row keeps its muted family glyph either way; a red warning mark beside a
 * label that already says "failed" states the verdict twice.
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
  const Icon = iconFor(step.parts[0]);

  return (
    <>
      {/* One child only — DisclosureTrigger clones each child into its own
			    clickable node, so a sibling caret would stack as a separate row. */}
      <ChainStepTrigger
        status={step.status}
        icon={<Icon className="text-muted-foreground size-4 flex-none" />}
        label={
          step.status === 'running' ? (
            <TextShimmer className="min-w-0 truncate leading-[1.5] font-medium">
              {step.label}
            </TextShimmer>
          ) : (
            <span className="min-w-0 truncate font-medium">{step.label}</span>
          )
        }
      />
      <DisclosureContent>
        {/*
          The members are a CHAIN, not a plain list — the same `ChainOfThought`
          the burst itself is built from, one level down.

          A group row is the only thing standing between the reader and N
          independent pieces of work, and some of those pieces open threads of
          their own: a `task` member expands into the whole sub-agent's step
          list. Rendered as bare siblings, the group's own hairline (drawn by
          the burst's `ChainOfThoughtStep`, in the GROUP's icon lane) was the
          only line on screen, so twenty rows belonging to the first agent had
          nothing tying them to that agent rather than to the group or to the
          agent below them. The list ran off the bottom unbounded.

          Wrapping each member in `ChainOfThoughtStep` answers that with the
          component that already exists rather than a second rail
          implementation: the step draws its hairline only while it is open, in
          ITS row's icon lane — 28px right of the group's, because that is where
          `pl-7` puts the member's glyph. One bar per level of nesting that
          actually exists, each anchored to the icon it hangs from.

          `ChainOfThought` also owns the `space-y-3` this div used to carry, for
          the reason written on that component: the gap belongs BETWEEN rows,
          not on them.
        */}
        <div className="mt-3 pl-7">
          <ChainOfThought>
            {step.parts.map((part) => (
              <ChainOfThoughtStep key={part.id}>
                <ActivityStep
                  part={part}
                  sessionId={sessionId}
                  running={running}
                  disableNavigation={disableNavigation}
                />
              </ChainOfThoughtStep>
            ))}
          </ChainOfThought>
        </div>
      </DisclosureContent>
    </>
  );
}

/**
 * Memo boundaries.
 *
 * The chat re-renders the streaming turn on every SSE frame. Without a boundary
 * that means every burst in that turn, every row in every burst, and every tool
 * renderer under those rows — including shiki — runs again for parts that did
 * not change. These boundaries are where the subtree can actually be cut.
 *
 * `ActivityBurst` compares `parts` element-wise rather than by identity, because
 * while a turn streams its segments are rebuilt each frame: the ARRAY is always
 * new, its contents almost never are. See `same-parts.ts`.
 *
 * `ActivityGroupStep` and `ThoughtChainStep` do NOT get a memoised `step` /
 * `texts` from `mergeBurstSteps` — the default shallow compare does NOT hold
 * for either, and both need their own element-wise comparator:
 *
 *   `mergeBurstSteps`'s `useMemo` in `ActivityBurst` is keyed on `[parts]`, and `parts` is a
 *   fresh array on every SSE delta of the streaming turn (see `same-parts.ts`).
 *   That re-runs `mergeBurstSteps` → `groupSteps` → `finalize` for every group
 *   in the burst, tools that already settled included, and `finalize` builds a
 *   brand-new `Step` object (and a brand-new `parts` array around the same
 *   `ToolPart` elements) every time it runs. So `step` is a new object identity
 *   per delta even when nothing in that particular group changed — the default
 *   shallow compare fails on `step` alone, and every open group row re-renders
 *   on every token of an unrelated streaming tool call in the same burst.
 *   Comparing `step` by its actual content — `status`, `label`, and the
 *   underlying `parts` element-wise (`samePartsList`, since `finalize` rebuilds
 *   that array too but reuses the same `ToolPart` objects inside it) — is what
 *   makes the boundary real. `texts` is exactly the same shape of problem one
 *   level up: `mergeBurstSteps` pushes a fresh `texts` array per thought run
 *   on every call, so `ThoughtChainStep` needs the same element-wise rule.
 *
 * `ActivityStep` (`activity-step.tsx`) is the one row in this chain where the
 * default shallow compare DOES hold: it takes `part` directly off the burst's
 * own `parts` prop — for an unwrapped run of one, `mergeBurstSteps` hands it
 * `step.parts[0]`, the very `Part` reference from the input array, never a
 * rebuilt copy. The session store only replaces the ONE part that actually
 * changed on a given SSE delta and keeps every sibling reference stable, so a
 * settled tool row's `part` prop keeps its identity across deltas that touch a
 * different part — `React.memo`'s reference check is correct there without a
 * custom comparator.
 *
 * `ChainOfThought` and `ChainOfThoughtStep` are deliberately NOT memoised: they
 * take `children`, which is a new element on every parent render, so a boundary
 * there can never hold and would only add a failed comparison.
 */
type ActivityGroupStepProps = {
  step: Step;
  sessionId: string;
  running: boolean;
  disableNavigation?: boolean;
};

/**
 * `ActivityGroupStep`'s memo comparator, exported so the boundary itself is
 * unit-tested rather than only exercised indirectly through a render.
 *
 * `step` is compared by content, not identity — see the memo-boundaries
 * comment above for why identity never holds across an SSE delta.
 */
export function sameActivityGroupStepProps(
  a: ActivityGroupStepProps,
  b: ActivityGroupStepProps,
): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.running === b.running &&
    a.disableNavigation === b.disableNavigation &&
    a.step.status === b.step.status &&
    a.step.label === b.step.label &&
    samePartsList(a.step.parts, b.step.parts)
  );
}

export const ActivityGroupStep = memo(ActivityGroupStepImpl, sameActivityGroupStepProps);
ActivityGroupStep.displayName = 'ActivityGroupStep';
