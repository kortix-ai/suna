import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Kortix <Card> — the codified panel surface.
 *
 * Mirrors the hand-composed `bg-popover rounded-md border` panels from the
 * customize section views. The bordered element carries no padding so flush
 * children (tables, lists, images) can sit edge-to-edge; padding lives on the
 * slots (`px-4`, `pt-5`/`pb-5`, `gap-5` between slots — the panel `px-4 py-5`
 * rhythm). Panels stay flat by default: border, no shadow — the shadow ladder
 * is for overlays and floating surfaces.
 */
const cardVariants = cva('bg-popover text-card-foreground flex flex-col gap-5 rounded-md border', {
  variants: {
    variant: {
      default: '',
      glass: 'bg-card/40 border-border/40 shadow-sm',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

interface CardProps extends React.ComponentProps<'div'>, VariantProps<typeof cardVariants> {}

function Card({ className, variant, ...props }: CardProps) {
  return <div data-slot="card" className={cn(cardVariants({ variant }), className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1 px-4 pt-5 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-4 [&:last-child]:pb-5',
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn('text-sm leading-none font-medium', className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-content"
      className={cn('px-4 [&:last-child]:pb-5', className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center gap-2 px-4 pb-5 [.border-t]:pt-4', className)}
      {...props}
    />
  );
}

export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cardVariants,
};
