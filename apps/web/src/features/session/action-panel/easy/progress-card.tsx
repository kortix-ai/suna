'use client';

/**
 * `ProgressCard` — the Easy-mode home's drill-in row into the step list.
 *
 * Always collapsed in place (chevron points right, tap navigates to
 * `ProgressView`); the card must still read as *alive*: while the agent is
 * running it shows the current step's own plain-language label with the
 * kortix text-shimmer sweeping across it, exactly like the boot checklist's
 * `StepLabelShimmer`. Once idle it settles into a calm summary. Zero steps is
 * a true, calm sentence, never a blank row that looks broken.
 */

import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';
import type { Step } from '../shared/group-steps';
import { progressSubtitle } from './progress-summary';

export function ProgressCard({
  steps,
  isRunning,
  onOpen,
}: {
  steps: Step[];
  isRunning: boolean;
  onOpen: () => void;
}) {
  const hasSteps = steps.length > 0;
  const subtitle = progressSubtitle(steps, isRunning);
  const showShimmer = isRunning && hasSteps;

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!hasSteps}
      className={cn(
        // `shrink-0`: same reasoning as `PanelCard` — a sibling in the same
        // flex column must never be squeezed below its own height by the
        // other cards' content; see the comment there.
        'border-border bg-popover flex min-h-11 w-full shrink-0 items-center justify-between gap-2 overflow-hidden rounded-md border px-4 py-3 text-left',
        'transition-[background-color,transform] active:scale-[0.998]',
        hasSteps ? 'hover:bg-muted-foreground/[0.04] cursor-pointer' : 'cursor-default',
      )}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground text-sm font-semibold">Progress</span>
        {showShimmer ? (
          <TextShimmer
            as="span"
            duration={1.8}
            spread={1.25}
            className="block max-w-full truncate text-sm"
          >
            {subtitle}
          </TextShimmer>
        ) : (
          <span className="text-muted-foreground truncate text-sm tabular-nums">{subtitle}</span>
        )}
      </span>
      <ChevronRight
        className={cn('text-muted-foreground size-4 shrink-0', !hasSteps && 'opacity-40')}
      />
    </button>
  );
}
