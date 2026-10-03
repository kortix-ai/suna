import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export function BoundaryColumn({
  label,
  items,
  emphasis,
  dashed,
}: {
  label: string;
  items: readonly string[];
  emphasis: boolean;
  dashed: boolean;
}): ReactNode {
  return (
    <div
      className={cn(
        'flex h-full flex-col rounded-sm p-5 sm:p-7',
        emphasis
          ? 'border-border bg-background border'
          : 'border-border bg-background/40 border',
        dashed && 'border-dashed',
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
                emphasis ? 'bg-foreground' : 'bg-muted-foreground/35',
              )}
            />
            <span
              className={cn(
                'text-sm leading-relaxed',
                emphasis ? 'text-foreground' : 'text-muted-foreground',
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
