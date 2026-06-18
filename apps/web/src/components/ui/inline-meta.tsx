'use client';

import { cn } from '@/lib/utils';
import { Children, Fragment, isValidElement, type ReactNode } from 'react';

export interface InlineMetaProps {
  className?: string;
  children: ReactNode;
}

export function InlineMeta({ className, children }: InlineMetaProps) {
  const items = Children.toArray(children).filter((c) => c !== null && c !== undefined && c !== '');
  return (
    <div
      className={cn(
        'text-muted-foreground/70 flex items-center gap-2 text-xs',
        'min-w-0',
        className,
      )}
    >
      {items.map((child, i) => (
        <Fragment key={isValidElement(child) ? (child.key ?? i) : i}>
          {i > 0 && <span className="text-muted-foreground/30">·</span>}
          <span className="truncate">{child}</span>
        </Fragment>
      ))}
    </div>
  );
}
