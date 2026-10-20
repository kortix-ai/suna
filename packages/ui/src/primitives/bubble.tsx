import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '../lib/utils';

/**
 * Bubble: the surface of one conversational message. The default variant is
 * the Kortix user bubble (`bg-muted`, `rounded-lg`, the session transcript's
 * BUBBLE_SURFACE). `align` pulls it to the row edge and squares the corner
 * that points at the speaker.
 */
const bubbleVariants = cva('relative w-fit max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm', {
  variants: {
    variant: {
      default: 'bg-muted text-foreground',
      secondary: 'bg-secondary text-secondary-foreground',
      outline: 'border border-border bg-transparent text-foreground',
      ghost: 'bg-transparent px-0 py-0 text-foreground',
      destructive: 'bg-destructive/10 text-foreground',
    },
    align: {
      start: 'mr-auto rounded-bl-sm',
      end: 'ml-auto rounded-br-sm',
    },
  },
  defaultVariants: { variant: 'default', align: 'start' },
});

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
      className={cn('font-medium wrap-break-word whitespace-pre-wrap select-text', className)}
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
  return <div data-slot="bubble-group" className={cn('flex flex-col gap-1', className)} {...props} />;
}

export { Bubble, BubbleContent, BubbleGroup, BubbleReactions, bubbleVariants };
