'use client';

/**
 * ChainOfThought — a vertical list of steps, each opening independently.
 *
 * Adapted from prompt-kit (https://prompt-kit.com/c/chain-of-thought.json),
 * then reduced to the two parts that are actually used: the list and the step.
 * Upstream's `ChainOfThoughtItem`, `ChainOfThoughtTrigger` and
 * `ChainOfThoughtContent` are gone — nothing imported them, and
 * `ChainOfThoughtContent` carried a SECOND rail implementation that contradicted
 * the one below.
 */

import * as React from 'react';

import { Disclosure } from '@/components/ui/disclosure';
import { cn } from '@/lib/utils';

export type ChainOfThoughtStepProps = React.ComponentProps<typeof Disclosure>;

/**
 * One step. It owns no spacing — the list does.
 *
 * A step used to carry `pb-3` (and `pb-2` when last), which made the gap a
 * property of the ROW rather than of the list. Two costs, both visible: the
 * final step left trailing padding that no following gap balanced, so a chain
 * sitting between two paragraphs was 12px from the one above and 20px from the
 * one below; and a chain of exactly one step — a single tool call — was a row
 * with 8px hanging off the bottom for no reason at all. `space-y` on the list
 * puts the gap BETWEEN rows, which is where a gap belongs: even everywhere,
 * absent at both ends.
 *
 * The rail draws only while the step is OPEN.
 *
 * It used to connect every step to the next, running the whole height of the
 * chain — a spine down a list of independent rows. That is not what the line
 * means. The line means "this content belongs to the row above it", which is
 * only true when there IS content, i.e. when the step is open. Drawn always, it
 * asserts a sequence the rows do not have, and it turns a quiet list into a
 * diagram.
 *
 * "Open" has to be asked TWO ways, because a step's content is not always
 * behind the step's own disclosure. A thought, a group and a file-chip row all
 * bind to this `Disclosure`, so `data-state` on the step answers for them. A
 * plain tool row does not: `ToolPartRenderer` brings its own nested
 * `Disclosure`, so expanding a `bash` row leaves the step reading `closed` and
 * the first rule silently never fires — which is exactly how a expanded command
 * ended up as the one row in the chain with no rail beside it. The `has-`
 * clause asks the descendants instead: if anything inside this step is open,
 * there is content, and content is what the line is for.
 *
 * Positioning: the rail is absolute so `bottom-0` stretches it to whatever the
 * step currently is — a search card, a command block, a paragraph of reasoning.
 * A fixed-height spacer cannot know how tall its sibling is, which is how the
 * old version visibly broke the moment a step expanded. `left-2` puts the
 * hairline on the 8px centre of the 16px leading icon, the column every step's
 * icon occupies; `top-[1.6rem]` clears that icon so the rail reads as hanging
 * from it rather than striking through it.
 */
export function ChainOfThoughtStep({ children, className, ...props }: ChainOfThoughtStepProps) {
  return (
    <Disclosure className={cn('group/step relative', className)} {...props}>
      <div
        aria-hidden
        className={cn(
          'bg-muted-foreground/15 absolute top-[1.6rem] bottom-0 left-2 w-[0.7px]',
          'hidden group-data-[state=open]/step:block',
          'group-has-[[data-state=open]]/step:block',
        )}
      />
      {children}
    </Disclosure>
  );
}

export type ChainOfThoughtProps = { children: React.ReactNode; className?: string };

/**
 * The list. One `space-y` and nothing else.
 *
 * This used to `React.cloneElement` every child to inject `isLast`, which the
 * step needed to decide its own padding and whether to draw a rail. Both
 * questions are gone — spacing lives here, and the rail follows open state — so
 * the clone went with them. A `map` + `cloneElement` on every render, for a list
 * that re-renders on every SSE frame, bought nothing.
 */
export function ChainOfThought({ children, className }: ChainOfThoughtProps) {
  return <div className={cn('space-y-3', className)}>{children}</div>;
}
