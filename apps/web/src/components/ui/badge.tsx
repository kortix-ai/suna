import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 py-[0.1rem] font-mono text-[0.8rem] font-medium tracking-tight [overflow-wrap:anywhere] has-[>svg]:gap-0.5 has-[>[data-slot=status-dot]]:gap-1 [&>svg]:block [&>svg]:!size-[0.75em] [&>svg]:shrink-0 [&>svg]:pointer-events-none [&>[data-slot=status-dot]]:shrink-0 [&>[data-slot=status-dot]]:!size-[0.45em] uppercase',
  {
    variants: {
      variant: {
        solid: 'bg-foreground/15 text-foreground ring-1 ring-inset ring-foreground/15',
        default: 'bg-foreground/10 text-foreground ring-1 ring-inset ring-foreground/10',
        secondary:
          'bg-secondary/80 text-secondary-foreground ring-1 ring-inset ring-border/60 normal-case',
        accent: 'bg-foreground/5 text-foreground ring-1 ring-inset ring-foreground/5',
        destructive: 'bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/10',
        success:
          'bg-kortix-green/15 text-foreground ring-1 ring-inset ring-kortix-green/15 [&>svg]:text-kortix-green',
        badgeSuccess:
          'bg-kortix-green/15 text-foreground ring-1 ring-inset ring-kortix-green/15 [&>svg]:text-kortix-green',
        update:
          'bg-kortix-orange/15 text-foreground ring-1 ring-inset ring-kortix-orange/15 [&>svg]:text-kortix-orange',
        kortix: 'bg-foreground/10 text-foreground ring-1 ring-inset ring-foreground/10',
        warning:
          'bg-kortix-orange/15 text-foreground ring-1 ring-inset ring-kortix-orange/15 [&>svg]:text-kortix-orange',
        outline: 'bg-transparent text-foreground ring-1 ring-inset ring-border normal-case',
        new: 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/10',
        beta: 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/10',
        highlight: 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/10',
        info: 'bg-kortix-blue/15 text-foreground ring-1 ring-inset ring-kortix-blue/15 normal-case [&>svg]:text-kortix-blue',
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
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span';

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
