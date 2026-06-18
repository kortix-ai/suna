import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50  [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none  aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive text-center cursor-pointer shadow-none focus-visible:outline-none focus-visible:ring-kortix-base focus-visible:ring-[0.6px]",

  {
    variants: {
      variant: {
        default: 'bg-foreground text-background hover:bg-foreground/90',
        brand:
          'bg-kortix-blue/90 dark:bg-kortix-blue/60 text-background dark:text-foreground shadow-xs hover:bg-kortix-blue/85 dark:hover:bg-kortix-blue/50 transition-colors duration-200 ease-in',
        blue: 'bg-kortix-blue text-background dark:text-foreground shadow-xs hover:bg-kortix-blue/90',
        'blue-ghost': 'hover:bg-sidebar-accent/40 text-kortix-blue',
        'blue-secondary': 'bg-kortix-blue/10 text-kortix-blue hover:bg-kortix-blue/20',
        danger: 'bg-destructive text-background hover:bg-destructive/90',
        destructive: 'bg-destructive/80 text-background hover:bg-destructive/85',
        outline:
          'border border-border bg-transparent text-foreground hover:bg-foreground/5 hover:text-foreground',
        'outline-ghost': 'border border-primary/10 hover:bg-background/50 hover:text-foreground',
        secondary: 'bg-secondary  hover:bg-secondary    text-foreground ',
        'secondary-outline': 'bg-secondary hover:bg-secondary border border-border text-foreground',
        sidebar:
          'text-sidebar-foreground hover:bg-sidebar-accent/80 flex items-center justify-start gap-2.5 w-full transition-colors duration-150 font-normal !h-8 !text-sm !px-2.5 !py-1.5 [&_svg]:!size-3.5',
        input: 'bg-input text-primary hover:bg-input',
        accent: 'bg-foreground/5 text-accent-foreground hover:bg-foreground/10 rounded-md',
        ghost: 'bg-transparent text-foreground hover:bg-foreground/10 hover:text-foreground',
        muted: 'bg-muted text-foreground hover:bg-muted/90',
        link: 'text-foreground underline-offset-4 hover:underline bg-transparent',
        foreground: 'bg-foreground text-foreground-foreground hover:bg-foreground/90',
        'outline-foreground':
          'border border-foreground/10 bg-foreground/80 hover:bg-foreground/90 text-foreground/80 hover:text-foreground',
        inverse:
          'w-fit dark:bg-[#0a0a0a] dark:hover:bg-[#0a0a0a]/95 dark:text-[#fafafa] bg-[#fafafa] hover:bg-[#fafafa]/95 text-[#0a0a0a]',
        'invert-outline-foreground':
          'border border-background/10 bg-foreground/90 hover:bg-foreground text-background hover:text-background',
        transparent: 'bg-transparent hover:bg-transparent text-foreground',
        text: 'text-muted-foreground hover:text-primary',

        'ghost-sidebar': 'bg-transparent hover:bg-sidebar hover:text-sidebar-accent-foreground',
        'outline-sidebar':
          'border border-border bg-transparent hover:bg-sidebar hover:text-sidebar-accent-foreground',

        success: 'bg-kortix-green/80 text-background hover:bg-kortix-green/85',
        error: 'bg-kortix-red/80 text-background hover:bg-kortix-red/85',
        info: 'bg-kortix-blue/80 text-background hover:bg-kortix-blue/85',
        warning: 'bg-kortix-yellow/80 text-background hover:bg-kortix-yellow/85',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: 'h-7  gap-1.5 px-2.5 has-[>svg]:px-2',
        base: "h-7 gap-1 px-2.5   in-data-[slot=button-group]:rounded-2xl has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: 'h-8  gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10  px-6 has-[>svg]:px-4',
        xl: 'h-12  px-8 has-[>svg]:px-6',
        icon: 'size-8 ',
        'icon-xs': 'size-6 ',
        'icon-sm': 'size-7 ',
        'icon-lg': 'size-10 ',
        'magic-sm': 'h-9 px-4 py-2 has-[>svg]:px-3  sm:h-8 sm:gap-1.5 sm:px-3 sm:has-[>svg]:px-2.5',

        toolbar: "h-7 gap-1.5 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
