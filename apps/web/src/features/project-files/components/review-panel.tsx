'use client';

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { cn } from '@/lib/utils';
import { XIcon } from '@phosphor-icons/react';

/**
 * Shared chrome for the two right-edge review drawers over the project repo —
 * `ChangeRequestsPanel` (proposed changes) and `CheckpointsPanel` (version
 * history).
 *
 * They were two ~300-line files with the same aside, the same header, the same
 * `groupByDate`, and the same hand-rolled loading / error / empty blocks. That
 * duplication is why they drifted, and it is where the border noise came from:
 * a header rule, a filter rule, and a group header carrying BOTH `border-t`
 * and `border-b` stacked four hairlines into the top 160px of a 400px panel.
 *
 * The rules here:
 *   • ONE hairline in the whole panel body — under the top block, where the
 *     controls stop and the content starts. Everything else separates by
 *     spacing and type weight.
 *   • Group labels are labels: no border, no fill, no backdrop blur, no sticky
 *     layer, no count, no collapse chevron.
 *   • Rows are soft chips (`mx-1 rounded-md`), not full-bleed bands with a
 *     `border-l-2` accent rail.
 */

/* ------------------------------------------------------------------ *
 * Grouping
 * ------------------------------------------------------------------ */

export interface DateGroup<T> {
  label: string;
  items: T[];
}

/**
 * Bucket newest-first items under Today / Yesterday / This week / "Month Year".
 *
 * One generic implementation. Both panels shipped a byte-identical private
 * copy of this, differing only in how they read a timestamp off the item.
 */
export function groupByDate<T>(items: T[], timestampOf: (item: T) => number): DateGroup<T>[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const thisWeekStart = new Date(today.getTime() - now.getDay() * 86_400_000);

  const groups = new Map<string, T[]>();
  for (const item of items) {
    const d = new Date(timestampOf(item));
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    let label: string;
    if (day.getTime() >= today.getTime()) label = 'Today';
    else if (day.getTime() >= yesterday.getTime()) label = 'Yesterday';
    else if (day.getTime() >= thisWeekStart.getTime()) label = 'This week';
    else label = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(item);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

export function ReviewPanel({
  open,
  onClose,
  title,
  actions,
  filters,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Icon buttons for the header's right edge, before Close. */
  actions?: ReactNode;
  /** Filter row under the title. Shares the header block's single hairline. */
  filters?: ReactNode;
  children: ReactNode;
}) {
  return (
    <aside
      aria-hidden={!open}
      aria-label={title}
      className={cn(
        'absolute top-0 right-0 bottom-0 z-30 flex w-[400px] max-w-full flex-col',
        'border-border bg-background border-l',
        'transition-transform duration-200 ease-out motion-reduce:transition-none',
        open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
      )}
    >
      {/* Header + filters are ONE block with ONE rule beneath it. */}
      <div className="border-border/60 shrink-0 border-b">
        <div className="flex h-11 items-center gap-1 pr-2 pl-3">
          <h2 className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
          {actions}
          <Hint label="Close" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close"
              className="text-muted-foreground hover:text-foreground active:scale-[0.96]"
            >
              <XIcon className="size-4" />
            </Button>
          </Hint>
        </div>
        {filters ? <div className="px-3 pb-2">{filters}</div> : null}
      </div>

      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full">{children}</ScrollArea>
      </div>
    </aside>
  );
}

/**
 * A date bucket's heading. Deliberately just a label — the old version was a
 * sticky, blurred, double-bordered `Disclosure` trigger with a count badge and
 * a rotating chevron, i.e. five pieces of chrome to say one word.
 */
export function ReviewGroupLabel({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <h3
      className={cn(
        'text-muted-foreground px-3 pb-1 text-xs font-medium',
        first ? 'pt-3' : 'pt-5',
      )}
    >
      {children}
    </h3>
  );
}

/**
 * A list row. Soft chip rather than a full-bleed band: hover and selection
 * read as a shape you can point at instead of a stripe across the panel.
 */
export function ReviewRow({
  isActive,
  onSelect,
  onPrefetch,
  children,
}: {
  isActive: boolean;
  onSelect: () => void;
  /** Warm the row's detail data on hover / touch, before the click lands. */
  onPrefetch?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      aria-current={isActive || undefined}
      className={cn(
        'mx-1 flex w-[calc(100%-0.5rem)] cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 text-left',
        'transition-colors',
        isActive ? 'bg-primary/[0.06]' : 'hover:bg-foreground/[0.04]',
      )}
    >
      {children}
    </button>
  );
}

/** Row skeleton shaped like a real row, so the swap does not jump. */
export function ReviewRowSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-1 px-3 pt-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-start gap-2.5 py-2">
          <Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Panel-sized error state — the system component, not a hand-rolled block. */
export function ReviewError({ title, error }: { title: string; error: unknown }) {
  return (
    <ErrorState
      size="sm"
      className="py-10"
      title={title}
      description={error instanceof Error ? error.message : undefined}
    />
  );
}

export { EmptyState as ReviewEmpty };
