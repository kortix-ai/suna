import { cva, type VariantProps } from 'class-variance-authority';

/**
 * The shared look for every disclosure trigger in the system — Select, Dropdown,
 * Popover, Sheet, Modal, Dialog. One definition so a bare trigger renders the
 * same box regardless of which overlay it opens.
 *
 * Only `outline` draws a visible border. Every other variant keeps
 * `border-transparent` from the base so the box metrics stay identical and a
 * row of mixed variants aligns to the same baseline.
 *
 * Triggers rendered with `asChild` opt out entirely — the child owns its styling.
 */
export const triggerVariants = cva(
  [
    'group/ui-trigger flex w-fit shrink-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-transparent font-normal outline-none',
    'text-foreground data-placeholder:text-muted-foreground',
    // Never `transition-all`: only the properties that actually change on hover/press.
    'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out',
    'motion-safe:active:scale-[0.98]',
    'focus-visible:ring-kortix-base focus-visible:ring-[0.6px] focus-visible:outline-none data-[state=open]:ring-0',
    'disabled:cursor-not-allowed disabled:opacity-50',
    '[&>span]:line-clamp-1 [&>span]:text-left',
  ],
  {
    variants: {
      variant: {
        secondary: 'bg-input hover:bg-input/80',
        outline: 'border-border bg-transparent hover:bg-foreground/5',
        transparent: 'bg-transparent hover:bg-foreground/5',
      },
      size: {
        sm: 'h-9 px-3 text-sm',
        md: 'h-10 px-3.5 text-sm',
        lg: 'h-11 px-4 text-base',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'sm',
    },
  },
);

export type TriggerVariantProps = VariantProps<typeof triggerVariants>;

/** Caret sizing per trigger size — matches the text step of each size. */
export const TRIGGER_ICON_SIZE = {
  sm: 'size-4',
  md: 'size-4',
  lg: 'size-4.5',
} as const;

/** The caret classes: muted, shrink-proof, and flipped while the overlay is open. */
export const TRIGGER_CARET_CLASS = [
  'text-muted-foreground shrink-0',
  'motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out',
  'group-data-[state=open]/ui-trigger:rotate-180',
].join(' ');
