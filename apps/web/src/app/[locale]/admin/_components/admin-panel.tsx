'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * A labelled block inside a page: heading and description ABOVE the surface,
 * content below it.
 *
 * This is the `project-settings-page.tsx` pattern — `<Label>` header, then a
 * `bg-popover rounded-md border` panel — and it exists so a panel never has to
 * host a header of its own. A header inside a bordered box needs either a seam
 * or a second padding rhythm, and both were how /admin ended up with panels
 * whose internal spacing disagreed panel to panel.
 *
 * Keeping the heading outside also means a flush child (a table, a chart) can
 * sit edge-to-edge in {@link AdminPanel} with nothing above it to align to.
 */
export function AdminSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  /** Trailing control on the heading row — a range picker, a link, a button. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 className="text-foreground text-sm font-medium">{title}</h2>
          {description ? (
            <p className="text-muted-foreground max-w-2xl text-xs leading-relaxed">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The padded flat panel — the single-block shorthand from
 * `kortix-design-system` → *Card & panel patterns*.
 *
 * Border, no shadow: it sits in page flow, and elevation in this system means
 * "floats above the page". Pass `flush` for a child that must reach the edges
 * (a chart canvas, a list with its own row padding).
 */
export function AdminPanel({
  children,
  flush = false,
  className,
}: {
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('bg-popover rounded-md border', flush ? '' : 'px-4 py-5', className)}>
      {children}
    </div>
  );
}

/**
 * Wrapper for a `<Table>` that is being refetched in the background.
 *
 * It draws NO border. `Table` already renders its own
 * `bg-popover rounded-md border overflow-hidden` container, so the bordered
 * `div` every admin table used to sit in produced two stacked frames with two
 * different radii — a nested rounded container, which the design system bans
 * outright and which read on screen as a doubled hairline.
 *
 * Opacity only, at `duration-fast`: the table is already on screen and the dim
 * is a status cue, not an entrance. Nothing here moves, so there is no
 * reduced-motion branch to ship.
 */
export function AdminTableFrame({
  busy = false,
  children,
  className,
}: {
  busy?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      aria-busy={busy || undefined}
      className={cn(
        'transition-opacity duration-fast ease-out',
        busy && 'opacity-70',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Empty / no-match state for a table or list. Carries the same
 * `bg-popover rounded-md border` frame the table it replaces would have drawn,
 * so the page does not change shape between "rows" and "no rows".
 */
export function AdminEmptyFrame({ children }: { children: ReactNode }) {
  return <div className="bg-popover rounded-md border">{children}</div>;
}
