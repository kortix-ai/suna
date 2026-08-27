import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const badgeColors = {
  gray: '#a3a3a3',
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  yellow: '#eab308',
  lime: '#84cc16',
  green: '#22c55e',
  emerald: '#10b981',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  blue: '#3b82f6',
  indigo: '#6366f1',
  violet: '#8b5cf6',
  purple: '#a855f7',
  fuchsia: '#d946ef',
  pink: '#ec4899',
  rose: '#f43f5e',
} as const;

type BadgeColor = keyof typeof badgeColors;

/** Framer tint badge: 10% fill + matching inset ring + saturated label color. */
function tintStyle(color: string) {
  const fill = `color-mix(in srgb, ${color} 10%, transparent)`;
  return {
    color,
    backgroundColor: fill,
    boxShadow: `inset 0 0 0 1px ${fill}`,
  } as const;
}

const badgeVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 py-[0.1rem] font-mono text-[0.8rem] font-medium tracking-tight [overflow-wrap:anywhere] has-[>svg]:gap-0.5 has-[>[data-slot=status-dot]]:gap-1 [&>svg]:block [&>svg]:!size-[0.75em] [&>svg]:shrink-0 [&>svg]:pointer-events-none [&>[data-slot=status-dot]]:shrink-0 [&>[data-slot=status-dot]]:!size-[0.45em] uppercase',
  {
    variants: {
      variant: {
        solid: '',
        default: 'bg-foreground/10 text-foreground ring-1 ring-inset ring-foreground/10',
        secondary:
          'bg-secondary/80 text-secondary-foreground ring-1 ring-inset ring-border/60 normal-case',
        accent: 'bg-foreground/5 text-foreground ring-1 ring-inset ring-foreground/5',
        destructive: 'bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/10',
        success:
          'bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/10 dark:text-emerald-400',
        badgeSuccess:
          'bg-teal-500/10 text-teal-700 ring-1 ring-inset ring-teal-500/10 dark:text-teal-400',
        update: 'bg-chart-2/10 text-kortix-orange ring-1 ring-inset ring-chart-2/10',
        kortix: 'bg-foreground/10 text-foreground ring-1 ring-inset ring-foreground/10',
        warning:
          'bg-amber-500/10 text-amber-700 ring-1 ring-inset ring-amber-500/10 dark:text-amber-400',
        outline: 'bg-transparent text-foreground ring-1 ring-inset ring-border normal-case',
        new: 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/10',
        beta: 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/10',
        highlight: 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/10',
        info: 'bg-neutral-500/10 text-neutral-700 ring-1 ring-inset ring-neutral-500/10 dark:text-neutral-400 normal-case',
        muted: 'bg-muted/50 text-muted-foreground ring-1 ring-inset ring-muted/50 normal-case',
        transparent: 'bg-transparent text-foreground ring-0 normal-case',
      },
      size: {
        default: 'px-1.5',
        sm: '',
        xs: '',
        tabular: 'min-w-5 gap-0 px-1 tabular-nums tracking-normal',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'xs',
    },
  },
);

function Badge({
  className,
  variant = 'solid',
  color = 'gray',
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean; color?: BadgeColor }) {
  const Comp = asChild ? Slot : 'span';

  const colorValue = badgeColors[color];
  const isSolid = variant === 'solid';

  const colorStyle = isSolid
    ? color === 'gray'
      ? tintStyle('var(--foreground)')
      : tintStyle(colorValue)
    : {};

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant, size }), className)}
      style={{ ...colorStyle }}
      {...props}
    />
  );
}

export { Badge, badgeColors, badgeVariants };
export type { BadgeColor };
