// import * as React from "react"
// import { Slot } from "@radix-ui/react-slot"
// import { cva, type VariantProps } from "class-variance-authority"

// import { cn } from "@/lib/utils"

// const buttonVariants = cva(
//   "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
//   {
//     variants: {
//       variant: {
//         default:
//           "bg-primary text-primary-foreground hover:bg-primary/90",
//         destructive:
//           "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
//         outline:
//           "border-[1.5px] bg-background hover:bg-accent hover:text-accent-foreground dark:bg-card dark:hover:bg-card/50",
//         secondary:
//           "bg-secondary text-secondary-foreground hover:bg-secondary/80",
//         ghost:
//           "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
//         link: "text-primary underline-offset-4 hover:underline",
//         // Tinted primary — bg-primary at 10% opacity
//         subtle:
//           "bg-primary/10 text-primary hover:bg-primary/15",
//         sidebar:
//           "text-sidebar-foreground hover:bg-sidebar-accent/80 flex items-center justify-start gap-2.5 w-full transition-colors duration-150 font-normal !h-8 !text-sm !px-2.5 !py-1.5 [&_svg]:!size-3.5",
//         // Muted ghost — neutral background on hover
//         muted:
//           "text-muted-foreground hover:bg-muted hover:text-foreground",
//         // Inverted — foreground as bg (white-on-black / black-on-white)
//         inverse:
//           "bg-foreground text-background hover:bg-foreground/90",
//         // Success — emerald tint
//         success:
//           "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400",
//       },
//       size: {
//         default: "h-9 px-4 py-2 text-sm rounded-full [&_svg:not([class*='size-'])]:size-4 has-[>svg]:px-3",
//         sm: "h-8 gap-1.5 px-3 text-sm rounded-full [&_svg:not([class*='size-'])]:size-4 has-[>svg]:px-2.5",
//         lg: "h-11 px-6 text-sm rounded-full [&_svg:not([class*='size-'])]:size-4 has-[>svg]:px-4",
//         icon: "size-9 rounded-full [&_svg:not([class*='size-'])]:size-4",
//         // Compact toolbar actions
//         toolbar: "h-7 gap-1.5 px-2.5 text-xs rounded-full [&_svg:not([class*='size-'])]:size-3.5",
//         // Micro buttons for inline/compact contexts
//         xs: "h-6 gap-1 px-2 text-xs rounded-full [&_svg:not([class*='size-'])]:size-3",
//         // Small icon button (toolbar density)
//         "icon-sm": "size-7 rounded-full [&_svg:not([class*='size-'])]:size-3.5",
//         // Tiny icon button (inline density)
//         "icon-xs": "size-6 rounded-full [&_svg:not([class*='size-'])]:size-3",
//       },
//     },
//     defaultVariants: {
//       variant: "default",
//       size: "default",
//     },
//   }
// )

// function Button({
//   className,
//   variant,
//   size,
//   asChild = false,
//   ...props
// }: React.ComponentProps<"button"> &
//   VariantProps<typeof buttonVariants> & {
//     asChild?: boolean
//   }) {
//   const Comp = asChild ? Slot : "button"

//   return (
//     <Comp
//       data-slot="button"
//       className={cn(buttonVariants({ variant, size, className }))}
//       {...props}
//     />
//   )
// }

// export { Button, buttonVariants }

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50  [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none  aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive text-center cursor-pointer shadow-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",

  {
    variants: {
      variant: {
        default: 'bg-foreground text-background hover:bg-foreground/90',
        brand:
          'bg-actrun-blue/90 dark:bg-actrun-blue/60 text-background dark:text-foreground shadow-xs hover:bg-actrun-blue/85 dark:hover:bg-actrun-blue/50 transition-colors duration-200 ease-in',
        blue: 'bg-actrun-blue text-background dark:text-foreground shadow-xs hover:bg-actrun-blue/90',
        'blue-ghost': 'hover:bg-sidebar-accent/40 text-actrun-blue',
        'blue-secondary':
          'bg-actrun-blue/10 text-actrun-blue hover:bg-actrun-blue/20',
        danger: 'bg-destructive text-background hover:bg-destructive/90',
        destructive:
          'bg-destructive/80 text-background hover:bg-destructive/85',
        outline:
          'border border-border bg-transparent text-foreground hover:bg-foreground/5 hover:text-foreground',
        'outline-ghost':
          'border border-primary/10 hover:bg-background/50 hover:text-foreground',
        secondary:
          'bg-secondary text-primary hover:bg-secondary  border border-border  text-foreground ',
        'outline-secondary': 'bg-secondary text-primary hover:bg-secondary ',
        input: 'bg-input text-primary hover:bg-input',
        accent:
          'bg-foreground/5 text-accent-foreground hover:bg-foreground/10 rounded-md',
        ghost:
          'bg-transparent text-foreground hover:bg-foreground/10 hover:text-foreground',
        muted: 'bg-muted text-foreground hover:bg-muted/90',
        link: 'text-foreground underline-offset-4 hover:underline bg-transparent',
        foreground:
          'bg-foreground text-foreground-foreground hover:bg-foreground/90',
        'outline-foreground':
          'border border-foreground/10 bg-foreground/80 hover:bg-foreground/90 text-foreground/80 hover:text-foreground',
        success: 'bg-emerald-500/60 text-foreground hover:bg-emerald-500/65',
        info: 'border border-blue-800 bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800',
        inverse:
          'w-fit dark:bg-[#0a0a0a] dark:hover:bg-[#0a0a0a]/95 dark:text-[#fafafa] bg-[#fafafa] hover:bg-[#fafafa]/95 text-[#0a0a0a]',
        'invert-outline-foreground':
          'border border-background/10 bg-foreground/90 hover:bg-foreground text-background hover:text-background',
        transparent: 'bg-transparent hover:bg-transparent text-foreground',
        text: 'text-muted-foreground hover:text-primary',

        'ghost-sidebar':
          'bg-transparent hover:bg-sidebar hover:text-sidebar-accent-foreground',
        'outline-sidebar':
          'border border-border bg-transparent hover:bg-sidebar hover:text-sidebar-accent-foreground',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: 'h-7 rounded-md gap-1.5 px-2.5 has-[>svg]:px-2',
        base: "h-7 gap-1 px-2.5   in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        xl: 'h-12 rounded-md px-8 has-[>svg]:px-6',
        icon: 'size-8 rounded-md',
        'icon-xs': 'size-6 rounded-sm',
        'icon-sm': 'size-7 rounded-md',
        'icon-lg': 'size-10 rounded-md',
        'magic-sm':
          'h-9 px-4 py-2 has-[>svg]:px-3  sm:h-8 sm:rounded-sm sm:gap-1.5 sm:px-3 sm:has-[>svg]:px-2.5',

        toolbar:
          "h-7 gap-1.5 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
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
    VariantProps<typeof buttonVariants> {
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
