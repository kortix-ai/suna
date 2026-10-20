import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '../lib/utils';

/**
 * Marker: an inline conversation note (a status update, a system note, a
 * "working" row, a labeled separator). `default` is inline, `border` is a row
 * with a bottom hairline, `separator` centers the label between two rules.
 */
const markerVariants = cva('text-muted-foreground flex items-center gap-1.5 text-xs', {
  variants: {
    variant: {
      default: '',
      border: 'border-border border-b pb-2',
      separator:
        "justify-center before:bg-border after:bg-border before:h-px before:flex-1 before:content-[''] after:h-px after:flex-1 after:content-['']",
    },
  },
  defaultVariants: { variant: 'default' },
});

function Marker({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof markerVariants>) {
  return <div data-slot="marker" className={cn(markerVariants({ variant }), className)} {...props} />;
}

function MarkerIcon({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="marker-icon"
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center [&_svg]:size-3.5', className)}
      {...props}
    />
  );
}

function MarkerContent({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="marker-content" className={cn('min-w-0 truncate', className)} {...props} />;
}

export { Marker, MarkerContent, MarkerIcon, markerVariants };
