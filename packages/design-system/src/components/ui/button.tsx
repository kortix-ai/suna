import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '../../lib/utils';

const buttonVariants = cva(
  "group/btn relative inline-flex shrink-0 items-center justify-center gap-2 rounded-full text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg]:transition-[stroke-width] [&_svg]:duration-150 hover:[&_svg]:[stroke-width:2] data-[loading=true]:cursor-wait data-[loading=true]:disabled:opacity-100 transition-[color,background-color,border-color,opacity,transform] duration-150 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/92 active:bg-primary/96',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/92',
        outline:
          'border border-foreground/12 bg-transparent text-foreground hover:bg-foreground/[0.04] hover:border-foreground/20 dark:border-foreground/14 dark:hover:bg-foreground/[0.06]',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/82',
        ghost: 'text-foreground hover:bg-foreground/[0.05] dark:hover:bg-foreground/[0.07]',
        link: 'text-primary underline-offset-4 hover:underline',
        soft: 'bg-accent text-accent-foreground hover:bg-accent/82',
      },
      size: {
        default: 'h-10 px-5 has-[>svg]:pl-4',
        xs: "h-7 gap-1 px-3 text-xs has-[>svg]:pl-2.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1.5 px-4 text-xs has-[>svg]:pl-3',
        lg: 'h-12 px-7 text-[0.95rem] has-[>svg]:pl-6',
        icon: 'size-10',
        'icon-xs': "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        'icon-sm': 'size-8',
        'icon-lg': 'size-12',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

interface ButtonProps extends React.ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  const isDisabled = disabled || loading;

  if (asChild) {
    return (
      <Comp
        data-slot="button"
        data-variant={variant}
        data-size={size}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      >
        {children}
      </Comp>
    );
  }

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? 'true' : undefined}
      aria-busy={loading || undefined}
      disabled={isDisabled}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      <span
        className={cn(
          'inline-flex items-center gap-2 transition-[opacity,font-variation-settings] duration-150 group-hover/btn:[font-variation-settings:var(--btn-fv-hover)]',
          loading && 'invisible opacity-0',
        )}
        style={
          {
            '--btn-fv-hover': "'wght' 550",
            fontVariationSettings: "'wght' 500",
          } as React.CSSProperties
        }
        aria-hidden={loading || undefined}
      >
        {children}
      </span>
      {loading ? (
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
          <ButtonDots />
        </span>
      ) : null}
      {loading ? <span className="sr-only">Loading</span> : null}
    </Comp>
  );
}

function ButtonDots() {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="size-1 rounded-full bg-current"
        style={{ animation: 'btn-dot 1.1s ease-in-out 0s infinite' }}
      />
      <span
        className="size-1 rounded-full bg-current"
        style={{ animation: 'btn-dot 1.1s ease-in-out 0.18s infinite' }}
      />
      <span
        className="size-1 rounded-full bg-current"
        style={{ animation: 'btn-dot 1.1s ease-in-out 0.36s infinite' }}
      />
    </span>
  );
}

export { Button, buttonVariants };
export type { ButtonProps };
