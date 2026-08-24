import { cn } from '@/lib/utils';

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'bg-muted text-muted-foreground pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded px-1 font-sans text-xs font-medium select-none',
        "[&_svg:not([class*='size-'])]:size-3",
        // A tooltip is an INVERTED surface (`bg-foreground text-background`), so
        // the default light `bg-muted` chip lands on it as a bright white blob.
        // Tint from the tooltip's own text color instead: one rule that reads
        // as a recessed key in both themes. This is the ONLY place the
        // in-tooltip look is defined — `tooltip-content` must not restyle keys
        // with a descendant `[&_kbd]` rule, or it also hits `KbdGroup`.
        '[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background',
        className,
      )}
      {...props}
    />
  );
}

// Renders a `<kbd>` on purpose: nested `<kbd>` is the HTML idiom for one key
// COMBINATION made of individual keys. It carries no chrome of its own — it is
// spacing only, so ancestors must never style it as if it were a key.
function KbdGroup({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
