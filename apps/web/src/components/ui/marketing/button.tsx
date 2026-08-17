import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const marketingButtonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[calc(var(--radius)-3px)] font-medium whitespace-nowrap transition-transform focus-visible:ring-1 focus-visible:outline-none active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none text-center [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 [&_svg]:drop-shadow-sm dark:shadow-md shadow-black/15",
  {
    variants: {
      variant: {
        default:
          'border-[0.5px] border-background/10 bg-foreground text-background  hover:bg-foreground/90 focus-visible:ring-foreground dark:border-transparent ',
        secondary:
          'border-[0.5px] border-foreground/10 bg-secondary text-secondary-foreground  hover:bg-secondary/80',
        outline:
          'border-[0.5px] border-foreground/10 bg-transparent text-foreground  hover:bg-secondary',
        destructive:
          'border-[0.5px] border-white/10 bg-destructive text-destructive-foreground  hover:bg-destructive/90 dark:border-transparent',
        ghost: 'bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground',
        transparent: 'bg-transparent text-foreground hover:bg-transparent',
        link: 'text-muted-foreground hover:text-foreground decoration-foreground/20 hover:decoration-foreground/50 mt-6 inline-block text-sm underline underline-offset-4 transition-colors',
      },
      size: {
        default: 'h-9 px-3.5 text-md rounded-[calc(var(--radius)-3px)]',
        sm: 'h-8 px-3 text-sm rounded-[calc(var(--radius)-3px)]',
        lg: 'h-10 px-4 text-md rounded-[calc(var(--radius-md)-0.4px)]',
        icon: 'size-9',
        'icon-sm': 'size-7.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof marketingButtonVariants> {
  asChild?: boolean;
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof marketingButtonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-slot="button"
      className={cn(marketingButtonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, marketingButtonVariants };
