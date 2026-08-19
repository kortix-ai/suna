'use client';

import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as React from 'react';

import { cn } from '@/lib/utils';
import { floatingZ, useDialogDepth } from '@/lib/z-stack';
import { FLOATING_PANEL } from './menu-recipe';
import { triggerVariants, type TriggerVariantProps } from './trigger-variants';

/**
 * The surface comes from `FLOATING_PANEL`, shared with the dropdown, context
 * menu and select — a popover is the same card, so it should not have its own
 * background, border, radius, shadow or enter/exit animation.
 *
 * What stays local is what a popover holds rather than what it is: `p-4`
 * because the content is prose and controls rather than a list of `p-1` rows,
 * a `w-72` default, and `outline-hidden` because Radix focuses the panel itself
 * on open and the ring would trace the whole card.
 */
const POPOVER_PANEL = cn(
  FLOATING_PANEL,
  'w-72 origin-(--radix-popover-content-transform-origin) p-4 outline-hidden',
);

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  className,
  variant,
  size,
  asChild,
  ...props
}: Omit<React.ComponentProps<typeof PopoverPrimitive.Trigger>, 'size'> & TriggerVariantProps) {
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      asChild={asChild}
      // With `asChild` the child owns its styling — merging ours would double it.
      className={asChild ? className : cn(triggerVariants({ variant, size }), className)}
      {...props}
    />
  );
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  container,
  style,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  container?: HTMLElement;
}) {
  const depth = useDialogDepth();
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(POPOVER_PANEL, className)}
        style={{ zIndex: floatingZ(depth), ...style }}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
