import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * Bubble — conversational message surface (shadcn `bubble`, built to the
 * documented API so a later `shadcn add bubble` is a clean drop-in).
 * Variants + alignment + grouping + reactions.
 */
const bubbleVariants = cva(
  'relative w-fit max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        muted: 'bg-muted text-muted-foreground',
        tinted: 'bg-brand/10 text-foreground',
        outline: 'border border-border bg-transparent',
        ghost: 'bg-transparent px-0 py-0',
        destructive: 'bg-destructive text-white',
      },
      align: {
        start: 'mr-auto rounded-bl-md',
        end: 'ml-auto rounded-br-md',
      },
    },
    defaultVariants: { variant: 'default', align: 'start' },
  },
);

function Bubble({
  className,
  variant,
  align,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof bubbleVariants>) {
  return (
    <div
      data-slot="bubble"
      data-align={align ?? 'start'}
      className={cn(bubbleVariants({ variant, align }), className)}
      {...props}
    />
  );
}

function BubbleContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="bubble-content"
      className={cn('whitespace-pre-wrap break-words', className)}
      {...props}
    />
  );
}

function BubbleReactions({
  className,
  side = 'bottom',
  align = 'end',
  ...props
}: React.ComponentProps<'div'> & { side?: 'top' | 'bottom'; align?: 'start' | 'end' }) {
  return (
    <div
      data-slot="bubble-reactions"
      data-side={side}
      className={cn(
        'flex flex-wrap gap-1',
        side === 'top' ? '-mt-1 mb-1' : '-mb-1 mt-1',
        align === 'end' ? 'justify-end' : 'justify-start',
        className,
      )}
      {...props}
    />
  );
}

function BubbleGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="bubble-group"
      className={cn('flex flex-col gap-1', className)}
      {...props}
    />
  );
}

export { Bubble, BubbleContent, BubbleReactions, BubbleGroup, bubbleVariants };
