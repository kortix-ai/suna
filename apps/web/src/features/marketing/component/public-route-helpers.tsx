import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export function SectionDivider(): ReactNode {
  return (
    <div className="mx-auto max-w-7xl px-6">
      <Separator />
    </div>
  );
}

/** A labelled list of key/value rows — the page's workhorse block. */
export function RowList({
  rows,
}: {
  rows: readonly { readonly id: string; readonly k: string; readonly v: string }[];
}): ReactNode {
  return (
    <dl className="border-border bg-card overflow-hidden rounded-sm border">
      {rows.map((row, i) => (
        <div
          key={row.id}
          className={cn(
            'border-border grid gap-2 px-6 py-6 sm:grid-cols-12 sm:gap-8 sm:px-8 sm:py-7',
            i > 0 && 'border-t',
          )}
        >
          <dt className="text-foreground font-mono text-[11px] tracking-widest uppercase sm:col-span-4">
            {row.k}
          </dt>
          <dd className="text-muted-foreground text-sm leading-relaxed sm:col-span-8">{row.v}</dd>
        </div>
      ))}
    </dl>
  );
}
