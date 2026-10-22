import type { ReactNode } from 'react';

import { cn } from '@kortix/ui';

/**
 * A flat, Linear-style table for the API pane's credential lists (service
 * account tokens, OAuth apps): a muted header row over a hairline, then rows
 * with no borders that fill on hover. Cells are fixed-width lanes so every
 * column lines up; the first cell takes the rest.
 */
export function IamTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="table" aria-label={label} className="flex flex-col">
      {children}
    </div>
  );
}

export function IamTableHead({ children }: { children: ReactNode }) {
  return (
    <div
      role="row"
      className="text-muted-foreground flex h-8 items-center gap-3 border-b px-3 text-xs"
    >
      {children}
    </div>
  );
}

export function IamTableRow({ muted, children }: { muted?: boolean; children: ReactNode }) {
  return (
    <div
      role="row"
      className={cn(
        'hover:bg-hover flex h-10 items-center gap-3 rounded-md px-3 text-sm',
        muted ? 'text-muted-foreground' : 'text-foreground',
      )}
    >
      {children}
    </div>
  );
}

/** One lane. `width` is a Tailwind width class; omit it for the flexible first column. */
export function IamTableCell({
  width,
  header,
  align = 'start',
  className,
  children,
}: {
  width?: string;
  header?: boolean;
  align?: 'start' | 'end';
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      role={header ? 'columnheader' : 'cell'}
      className={cn(
        'flex min-w-0 items-center gap-2',
        width ? cn(width, 'shrink-0') : 'flex-1',
        align === 'end' && 'justify-end text-right',
        className,
      )}
    >
      {children}
    </div>
  );
}
