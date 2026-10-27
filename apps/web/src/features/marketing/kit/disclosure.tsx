import { PlusIcon } from '@phosphor-icons/react/dist/ssr';
import { type ReactNode } from 'react';

import { cn } from '@kortix/ui';

/** The hairline frame around a run of `Disclosure` rows: a rule above, between and below. */
export function DisclosureList({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('divide-border border-border divide-y border-y', className)}>{children}</div>
  );
}

/**
 * One open/close row (Buio FAQ): a native `details`, so Enter and Space work
 * with no script, and `name` keeps one row of a group open. The summary dims
 * on hover; the "+" turns into "×" over `duration-moderate` (a disclosure is
 * an "often" interaction). The answer height does not animate.
 *
 * `summary` is phrasing content only: a `summary` may not hold a heading next
 * to other content, so pass spans.
 */
export function Disclosure({
  summary,
  children,
  id,
  name,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  id?: string;
  name?: string;
  className?: string;
}) {
  return (
    <details id={id} name={name} className={cn('group scroll-mt-16', className)}>
      <summary className="text-foreground hover:text-muted-foreground outline-ring duration-moderate flex cursor-pointer list-none items-start justify-between gap-6 py-6 text-lg transition-colors select-none focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 text-pretty">{summary}</span>
        <PlusIcon
          aria-hidden
          className="duration-moderate mt-1.5 size-4 shrink-0 transition-transform ease-out group-open:rotate-45 motion-reduce:transition-none"
        />
      </summary>
      <div className="pb-6">{children}</div>
    </details>
  );
}
