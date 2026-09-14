'use client';

import { HoverCard as HoverCardPrimitive } from 'radix-ui';
import * as React from 'react';

import { cn } from '@/lib/utils';
import { FLOATING_PANEL, FLOATING_PANEL_SURFACE } from './menu-recipe';

function HoverCard({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />;
}

/**
 * The fifth panel to join `FLOATING_PANEL`.
 *
 * `menu-recipe.ts` reconciled the dropdown, context menu, select and popover
 * surfaces onto one description of "a hairline-bordered card lifted off the
 * canvas". This one was missed and kept its own `rounded-md` + `shadow-sm`,
 * so a hover card sat a step flatter and 2px tighter than every other floating
 * panel — which is why `token-progress.tsx` had to patch `shadow-md` back on at
 * its call site. The recipe owns the surface and the enter/exit now.
 *
 * Two things stay local because they are this primitive's own: the transform
 * origin (the Radix variable is named per primitive) and the `motion-reduce`
 * guard, which no other panel ships and which must survive the move.
 *
 * `animated={false}` takes `FLOATING_PANEL_SURFACE` instead, the same split
 * `MENU_PANEL_STATIC` makes for submenus, and for the same reason: a panel that
 * opens INTO the path the pointer is already travelling spends its enter
 * animation moving content away from the cursor, which reads as the card
 * lagging behind the hand rather than as polish.
 */
function HoverCardContent({
  className,
  align = 'center',
  sideOffset = 4,
  animated = true,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content> & { animated?: boolean }) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          animated ? FLOATING_PANEL : FLOATING_PANEL_SURFACE,
          'z-50 w-64 origin-(--radix-hover-card-content-transform-origin) p-4 outline-hidden motion-reduce:animate-none motion-reduce:transition-none',
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
