import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border-[1.5px] bg-background hover:bg-accent hover:text-accent-foreground dark:bg-card dark:hover:bg-card/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
        // Tinted primary — bg-primary at 10% opacity
        subtle:
          "bg-primary/10 text-primary hover:bg-primary/15",
        sidebar:
          "font-medium text-sidebar-foreground hover:bg-sidebar-accent/80 flex items-center justify-start gap-3 w-full transition-colors duration-150",
        // Muted ghost — neutral background on hover
        muted:
          "text-muted-foreground hover:bg-muted hover:text-foreground",
        // Inverted — foreground as bg (white-on-black / black-on-white)
        inverse:
          "bg-foreground text-background hover:bg-foreground/90",
        // Success — emerald tint
        success:
          "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400",
      },
      size: {
        default: "h-9 px-4 py-2 text-sm rounded-full [&_svg:not([class*='size-'])]:size-4 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-3 text-sm rounded-full [&_svg:not([class*='size-'])]:size-4 has-[>svg]:px-2.5",
        lg: "h-11 px-6 text-sm rounded-full [&_svg:not([class*='size-'])]:size-4 has-[>svg]:px-4",
        icon: "size-9 rounded-full [&_svg:not([class*='size-'])]:size-4",
        // Compact toolbar actions
        toolbar: "h-7 gap-1.5 px-2.5 text-[0.6875rem] rounded-full [&_svg:not([class*='size-'])]:size-3.5",
        // Micro buttons for inline/compact contexts
        xs: "h-6 gap-1 px-2 text-[0.625rem] rounded-full [&_svg:not([class*='size-'])]:size-3",
        // Small icon button (toolbar density)
        "icon-sm": "size-7 rounded-full [&_svg:not([class*='size-'])]:size-3.5",
        // Tiny icon button (inline density)
        "icon-xs": "size-6 rounded-full [&_svg:not([class*='size-'])]:size-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
