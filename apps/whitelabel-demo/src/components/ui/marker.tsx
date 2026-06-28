import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * Marker — inline conversation markers: status updates, system notes, "thinking"
 * rows, and labeled separators (shadcn `marker`, built to the documented API).
 * Variants: default (inline), border (row with bottom border), separator
 * (centered label between divider lines).
 */
const markerVariants = cva('flex items-center gap-1.5 text-xs text-muted-foreground', {
  variants: {
    variant: {
      default: '',
      border: 'border-b border-border pb-2',
      separator:
        "justify-center before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border before:content-[''] after:content-['']",
    },
  },
  defaultVariants: { variant: 'default' },
});

function Marker({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof markerVariants>) {
  return (
    <div data-slot="marker" className={cn(markerVariants({ variant }), className)} {...props} />
  );
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

export { Marker, MarkerIcon, MarkerContent, markerVariants };
