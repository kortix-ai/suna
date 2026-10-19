import { cva, type VariantProps } from 'class-variance-authority';

/**
 * The shared look for every disclosure trigger in the system — Select, Dropdown,
 * Popover, Sheet, Modal, Dialog. One definition so a bare trigger renders the
 * same box regardless of which overlay it opens.
 *
 * `secondary` (default) and `outline` draw the input field surface; `transparent`
 * keeps `border-transparent` from the base, so the box metrics stay identical
 * and a row of mixed variants aligns to the same baseline.
 *
 * Triggers rendered with `asChild` opt out entirely — the child owns its styling.
 */
/** Literal classes, not composed from input.tsx, so Tailwind can see every prefixed one. */
const fieldTriggerClasses = [
  'bg-popover border-border',
  'focus-visible:border-ring focus-visible:ring-ring/15 focus-visible:ring-3',
  'data-[state=open]:border-ring data-[state=open]:ring-ring/15 data-[state=open]:ring-3',
].join(' ');

export const triggerVariants = cva(
  [
    'group/ui-trigger flex w-fit shrink-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-transparent font-normal outline-none',
    'text-foreground data-placeholder:text-muted-foreground',
    // Never `transition-all`: only the properties that actually change on hover/press.
    'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out',
    'focus-visible:ring-kortix-base focus-visible:ring-[0.6px] focus-visible:outline-none data-[state=open]:ring-0',
    'disabled:cursor-not-allowed disabled:opacity-50',
    // One line, ellipsised. `truncate`, not `line-clamp-1`: line-clamp sets
    // `display: -webkit-box` on every direct <span>, which out-ranks a child's
    // own `flex` — an icon + label wrapper then stacked the icon ABOVE the
    // label and lost its gap. `truncate` changes overflow only, not display.
    '[&>span]:min-w-0 [&>span]:truncate [&>span]:text-left',
  ],
  {
    variants: {
      variant: {
        // `secondary` and `outline` are form-field triggers: they draw the exact
        // surface `Input` draws (`inputSurfaceClasses` in input.tsx), and an OPEN
        // trigger shows the same border + 3px halo as a focused input, so a
        // Select beside a text field reads as one form.
        secondary: fieldTriggerClasses,
        outline: fieldTriggerClasses,
        // Only the borderless toolbar trigger takes a press scale. A form field
        // does not shrink under the pointer — an input never does, and a
        // Select beside it should behave the same.
        transparent: 'bg-transparent hover:bg-foreground/5 motion-safe:active:scale-[0.98]',
      },
      size: {
        sm: 'h-8 px-2.5 text-sm',
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
