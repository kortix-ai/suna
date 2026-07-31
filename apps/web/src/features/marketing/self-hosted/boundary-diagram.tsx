import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { yours } from './content';

/**
 * Where the line actually falls when you self-host: what sits on your box, and
 * what does not. The right-hand column exists because the honest version of
 * this page has to draw it — sandbox compute runs on the provider you
 * configure, not on the box, and a reviewer finds that out in ten minutes
 * whether or not the page says so.
 */

function Column({
  label,
  items,
  variant,
}: {
  label: string;
  items: readonly string[];
  variant: 'on' | 'off';
}): ReactNode {
  return (
    <div
      className={cn(
        'flex h-full flex-col rounded-sm p-5 sm:p-7',
        variant === 'on'
          ? 'border-border bg-background border'
          : 'border-border bg-background/40 border border-dashed',
      )}
    >
      <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
        {label}
      </p>
      <ul className="mt-5 space-y-3">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-3">
            <span
              aria-hidden
              className={cn(
                'mt-[7px] size-1.5 shrink-0 rounded-full',
                variant === 'on' ? 'bg-foreground' : 'bg-muted-foreground/35',
              )}
            />
            <span
              className={cn(
                'text-sm leading-relaxed',
                variant === 'on' ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {item}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BoundaryDiagram(): ReactNode {
  return (
    <div className="border-border bg-card rounded-sm border p-5 sm:p-8">
      <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch lg:gap-0">
        <Column label={yours.onbox.label} items={yours.onbox.items} variant="on" />

        <div className="relative flex items-center justify-center lg:w-24">
          <span aria-hidden className="bg-border absolute inset-x-0 top-1/2 h-px lg:hidden" />
          <span
            aria-hidden
            className="bg-border absolute inset-y-0 left-1/2 hidden w-px lg:block"
          />
          <span className="border-border bg-card text-muted-foreground relative rounded-sm border px-2.5 py-1 font-mono text-[10px] tracking-widest uppercase">
            your box
          </span>
        </div>

        <Column label={yours.offbox.label} items={yours.offbox.items} variant="off" />
      </div>

      <p className="text-muted-foreground border-border mt-6 border-t pt-6 text-sm leading-relaxed">
        {yours.offbox.note}
      </p>
    </div>
  );
}
