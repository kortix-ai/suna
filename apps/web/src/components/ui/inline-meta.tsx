'use client';

/**
 * Kortix <InlineMeta> — the `a · b · c · d` metadata strip.
 *
 * Used wherever you want to surface a handful of small facts about a
 * resource (path, count, date, owner) in a single line. Children are
 * automatically separated by the Kortix dot.
 *
 *   <InlineMeta>
 *     <span className="font-mono">/workspace/foo</span>
 *     <span>24 issues</span>
 *     <span>created 2d ago</span>
 *   </InlineMeta>
 *
 * Falsy children are skipped, so you can safely drop conditional items.
 */

import { cn } from '@/lib/utils';
import { Children, Fragment, isValidElement, type ReactNode } from 'react';

export interface InlineMetaProps {
  className?: string;
  children: ReactNode;
}

export function InlineMeta({ className, children }: InlineMetaProps) {
  const items = Children.toArray(children).filter(
    (c) => c !== null && c !== undefined && c !== '',
  );
  return (
    <div
      className={cn(
        'flex items-center gap-2 text-[12px] text-muted-foreground/70',
        'min-w-0',
        className,
      )}
    >
      {items.map((child, i) => (
        <Fragment key={isValidElement(child) ? child.key ?? i : i}>
          {i > 0 && <span className="text-muted-foreground/30">·</span>}
          <span className="truncate">{child}</span>
        </Fragment>
      ))}
    </div>
  );
}
