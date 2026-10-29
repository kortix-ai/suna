'use client';

import { useMediaQuery } from '../hooks';
import { PopoverContent } from '../../primitives/popover';
import { useSidebar } from '../../primitives/sidebar';
import { cn } from '../../lib/utils';
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
  type RefObject,
} from 'react';

/** Time the pointer rests on the row before the card opens, so passing over it does nothing. */
const HOVER_OPEN_DELAY_MS = 400;
/** Time to cross the gap between the row and its card before it closes. Same as the More row. */
const HOVER_CLOSE_DELAY_MS = 150;

/**
 * The hover card of a sidebar nav row (Apps, Customize): a mouse that rests on
 * the row opens a list of where the row leads, so one click lands on the
 * thing instead of two. The row stays a plain link: the card is a Popover
 * anchored to it (`anchorRef` as `PopoverAnchor virtualRef`), not a menu
 * trigger, which would take Enter and Space for itself.
 *
 * It opens only where hover exists (the session list's gate) and only on the
 * expanded sidebar: the collapsed rail shows the row's tooltip there.
 * `holdRef` names an input that keeps the card open while it has focus.
 */
export function useNavHoverCard({
  enabled,
  holdRef,
}: {
  enabled: boolean;
  holdRef?: RefObject<HTMLElement | null>;
}) {
  const canHover = useMediaQuery('(min-width: 768px) and (hover: hover) and (pointer: fine)');
  const { state } = useSidebar();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const active = enabled && canHover && state === 'expanded';

  const cancelTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };
  useEffect(() => cancelTimers, []);

  // An open card stays open while the pointer crosses between row and card;
  // a closed one opens only after the pointer rests on the row.
  const hoverOpen = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse' || !active) return;
    cancelTimers();
    if (open) return;
    openTimer.current = setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS);
  };
  const hoverClose = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse') return;
    cancelTimers();
    closeTimer.current = setTimeout(() => {
      // Typing in the card keeps it; a click outside or Escape closes it.
      if (holdRef?.current && document.activeElement === holdRef.current) return;
      setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  };

  return {
    open: open && active,
    setOpen,
    anchorRef: anchorRef as RefObject<HTMLElement>,
    rowProps: {
      onPointerEnter: (event: PointerEvent<HTMLElement>) => {
        anchorRef.current = event.currentTarget;
        hoverOpen(event);
      },
      onPointerLeave: hoverClose,
      onClick: () => {
        cancelTimers();
        setOpen(false);
      },
    },
    contentProps: { onPointerEnter: hoverOpen, onPointerLeave: hoverClose },
  };
}

/** The card's panel: to the right of the row, top edges aligned, never taking focus. */
export function NavHoverCardContent({ className, ...props }: ComponentProps<typeof PopoverContent>) {
  return (
    <PopoverContent
      side="right"
      align="start"
      sideOffset={8}
      className={cn('w-60 overflow-hidden p-0', className)}
      // Hover must not move focus: the row keeps it, and so does the page.
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      {...props}
    />
  );
}

/** The card's list: the floating-list padding. A list that can grow long sets its own cap. */
export function NavHoverCardList({ className, ...props }: ComponentProps<'ul'>) {
  return <ul className={cn('p-1', className)} {...props} />;
}
