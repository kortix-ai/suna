import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { isolation } from './content';

/**
 * The trust boundary, drawn once: a dashed wall around one session, what is
 * inside it, and what is on the other side and stays there. Built from divs and
 * mono type rather than an image, so it stays sharp at any width, themes
 * correctly, and reads to a screen reader as the two lists it actually is.
 */

function Column({
  label,
  items,
  variant,
}: {
  label: string;
  items: readonly string[];
  variant: 'inside' | 'outside';
}): ReactNode {
  return (
    <div
      className={cn(
        'flex h-full flex-col rounded-sm p-5 sm:p-7',
        variant === 'inside'
          ? 'border-border bg-background border border-dashed'
          : 'border-border bg-background/40 border',
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
                variant === 'inside' ? 'bg-foreground' : 'bg-muted-foreground/35',
              )}
            />
            <span
              className={cn(
                'text-sm leading-relaxed',
                variant === 'inside' ? 'text-foreground' : 'text-muted-foreground',
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
        <Column
          label={isolation.inside.label}
          items={isolation.inside.items}
          variant="inside"
        />

        {/* the wall itself: a vertical rule with the boundary named on it */}
        <div className="relative flex items-center justify-center lg:w-24">
          <span aria-hidden className="bg-border absolute inset-x-0 top-1/2 h-px lg:hidden" />
          <span
            aria-hidden
            className="bg-border absolute inset-y-0 left-1/2 hidden w-px lg:block"
          />
          <span className="border-border bg-card text-muted-foreground relative rounded-sm border px-2.5 py-1 font-mono text-[10px] tracking-widest uppercase">
            sandbox
          </span>
        </div>

        <Column
          label={isolation.outside.label}
          items={isolation.outside.items}
          variant="outside"
        />
      </div>
    </div>
  );
}
