import { DisclosureTrigger } from '@/components/ui/disclosure';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';
import { CaretRightIcon } from '@phosphor-icons/react';

export function BurstSummaryTrigger({
  bare,
  running,
  title,
}: {
  bare: boolean;
  running: boolean;
  title: string;
}) {
  return (
    <>
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
    </>
  );
}
