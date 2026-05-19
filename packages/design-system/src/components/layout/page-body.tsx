import * as React from 'react';
import { cn } from '../../lib/utils';

export interface PageBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

/**
 * Page body — the post-header content area. Adds the standard top spacing
 * (`pt-10`) so children align with the editorial rhythm. Sections inside
 * still control their own internal vertical gaps.
 */
export function PageBody({ className, children, ...props }: PageBodyProps) {
  return (
    <div data-slot="page-body" className={cn('flex flex-1 flex-col pt-10', className)} {...props}>
      {children}
    </div>
  );
}
