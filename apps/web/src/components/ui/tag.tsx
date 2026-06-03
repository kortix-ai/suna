import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const tagVariants = cva(
  'px-1.5 py-0.5 rounded text-xs font-medium leading-none shrink-0 inline-flex items-center',
  {
    variants: {
      variant: {
        default: 'bg-muted text-muted-foreground',
        free: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        latest: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
        custom: 'bg-muted text-muted-foreground',
        new: 'bg-primary/10 text-primary',
        warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Tag({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof tagVariants>) {
  return (
    <span
      data-slot="tag"
      className={cn(tagVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Tag };
