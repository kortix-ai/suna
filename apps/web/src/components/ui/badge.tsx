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

const badgeVariants = cva(
  'border-transparent   disabled:border-alpha-300 focus-visible:ring-offset-background outline-hidden has-focus-visible:ring-2 pointer-events-none inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap  px-2.5 py-1 text-xs font-medium ring-blue-600 transition-all focus-visible:ring-2 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400 disabled:ring-0 [&>svg]:pointer-events-none bg-accent text-accent-foreground hover:bg-accent focus:bg-accent focus-visible:bg-accent has-[>svg]:pl-[10px] [&>svg]:size-3 h-6 rounded-full',
  {
    variants: {
      variant: {
        solid: '',
        default: 'border border-foreground/10 bg-foreground text-background',
        secondary: 'border border-secondary/10 bg-secondary text-secondary-foreground',
        accent: 'bg-foreground/5  ',
        destructive:
          'border-transparent bg-red-100   text-red-800   dark:bg-red-900/30 dark:text-red-400',
        success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
        badgeSuccess:
          'border-transparent bg-emerald-200   text-emerald-800   dark:bg-emerald-900/50 dark:text-emerald-500 disabled:border-alpha-300 focus-visible:ring-offset-background outline-hidden has-focus-visible:ring-2 pointer-events-none inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full   ring-blue-600 transition-all focus-visible:ring-2 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400 disabled:ring-0 [&>svg]:pointer-events-none   bg-teal-100 text-teal-700 hover:bg-teal-100  focus:bg-teal-100   focus-visible:bg-teal-100 has-[>svg]:pl-[10px] [&>svg]:size-3 h-6 px-1.5 text-[11px] font-medium',
        update: 'border-transparent bg-chart-2/25 border   text-chart-2',
        warning:
          'border-transparent bg-amber-400/30 border  text-amber-800  dark:bg-amber-400/30 dark:text-amber-800',
        outline: 'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        new: 'border-transparent bg-primary/15 text-primary',
        beta: 'border-transparent bg-primary/15 text-primary',
        highlight: 'border-transparent bg-primary/15 text-primary',
        info: 'border-transparent bg-neutral-200 border  text-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-500',
        muted: 'border-transparent bg-muted/50 text-muted-foreground',
        transparent: 'border-transparent bg-transparent text-foreground',
      },
      size: {
        default: 'px-3 py-1.5 text-xs gap-1 [&>svg]:size-3',
        sm: 'px-2 py-0.5 text-xs gap-0.5 [&>svg]:size-2.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
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
      ? { backgroundColor: 'var(--accent)', color: 'var(--foreground)' }
      : {
          color: 'var(--foreground)',
          backgroundColor: `color-mix(in srgb, ${colorValue} 15%, var(--background))`,
        }
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
