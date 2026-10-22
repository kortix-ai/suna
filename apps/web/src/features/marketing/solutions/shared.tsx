import { cn } from '@kortix/ui';
import type { ReactNode } from 'react';

/**
 * The measure every Solutions section rides.
 *
 * The rest of the marketing site is still on `max-w-7xl`; the site is being
 * swept onto a wider shared measure, and these pages are built on the target so
 * they do not have to be re-laid-out afterwards. Change it here and every
 * Solutions section moves together.
 */
export const SOLUTIONS_MEASURE = 'mx-auto max-w-7xl px-6';

/**
 * A bordered definition list — mono key on the left, prose on the right. Used
 * for "where it reaches" and "what lands, and what does not" on every role page.
 */
export function DefinitionRows({
  rows,
  keyClassName,
}: {
  rows: readonly { readonly k: string; readonly v: string }[];
  keyClassName?: string;
}): ReactNode {
  return (
    <dl className="border-border bg-card overflow-hidden rounded-sm border">
      {rows.map((row, i) => (
        <div
          key={row.k}
          className={cn(
            'border-border grid gap-2 px-6 py-6 sm:grid-cols-12 sm:gap-8 sm:px-8 sm:py-7',
            i > 0 && 'border-t',
          )}
        >
          <dt
            className={cn(
              'text-foreground font-mono text-[11px] tracking-widest uppercase sm:col-span-4',
              keyClassName,
            )}
          >
            {row.k}
          </dt>
          <dd className="text-muted-foreground text-sm leading-relaxed sm:col-span-8">{row.v}</dd>
        </div>
      ))}
    </dl>
  );
}
