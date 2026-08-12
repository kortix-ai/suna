'use client';

import { cn } from '@/lib/utils';
import { useEffect, useRef } from 'react';

/**
 * The floating card both the `@` and `/` menus render into.
 *
 * Design-system compliance (`.claude/skills/kortix-design-system/SKILL.md`):
 *  - `rounded-md`, not `rounded-xl` — "Never: rounded-xl / rounded-2xl on app
 *    containers". The previous menus used `rounded-xl` with `rounded-lg` rows,
 *    which is also nested rounding, banned by the same rule.
 *  - Overlays pair the elevation ladder's `shadow-md` WITH a hairline border.
 *
 * Stacking is deliberately NOT set here. This card is a React child of the
 * element the suggestion plugin appends to `document.body`, and a child cannot
 * lift its parent above a sibling stacking context — a `z-50` on this div would
 * look like it was doing something while changing nothing. The z-index belongs
 * on the mounted element itself and is set in `mount.ts`.
 */
export function MenuCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'bg-popover text-popover-foreground overflow-hidden rounded-md border shadow-md',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Section label above a group of rows ("Skills", "Agents", "Connectors"). */
export function MenuSectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground px-2 pb-1 text-sm font-medium">{children}</div>
  );
}

export interface MenuRowProps {
  id: string;
  selected: boolean;
  onSelect: () => void;
  /**
   * The pointer genuinely moved over this row — make it the selected row.
   * Optional: a menu that leaves it off keeps the plain `hover:` tint and a
   * separate keyboard highlight.
   */
  onHover?: () => void;
  children: React.ReactNode;
  className?: string;
}

/**
 * One selectable row.
 *
 * `bg-primary/[0.06]` for the selected state, never `bg-muted` — the design
 * system reserves muted for surfaces and mandates a primary tint for
 * active/selected. Hover uses a lighter step of the same tint so hover and
 * selection read as one scale rather than two unrelated greys.
 *
 * `onMouseDown` + `preventDefault`, never `onClick`: the editor must not lose
 * its selection before the row's command runs — the suggestion `command`
 * callback deletes the trigger range by position, and a blurred editor has no
 * range to delete.
 *
 * Scroll-into-view is handled here rather than by the parent list because the
 * row is the only thing that knows its own DOM node. Without it, arrowing past
 * the bottom of a scrollable list moves an invisible selection — the list stays
 * put and the highlighted row is off-screen.
 *
 * ## Why hover uses `pointermove`, not `pointerenter`
 *
 * `pointerenter`/`mouseenter` fire whenever the element moves under the
 * cursor — including when the LIST scrolls under a cursor that never moved.
 * Wiring hover-to-select to them means arrowing down the list slides the next
 * row beneath a resting mouse, which fires enter, which drags the selection
 * straight back: the keyboard and the mouse fight and the keyboard loses.
 * `pointermove` fires only on real pointer travel, so a stationary mouse
 * cannot claim anything. (Same reason `cmdk` and Radix's menus use it.)
 *
 * Touch is excluded: a finger dragging across the list to scroll it is not
 * "hovering", and repainting the `/` menu's detail pane under the drag would
 * be pure noise.
 */
export function MenuRow({ id, selected, onSelect, onHover, children, className }: MenuRowProps) {
  const ref = useRef<HTMLButtonElement | null>(null);
  /**
   * The other half of the same fight. A hovered row must NOT scroll itself
   * into view: reach for the half-clipped row at the bottom edge, and a
   * `scrollIntoView` triggered by your own hover slides the list up under the
   * cursor, putting a different row where you were aiming. Only keyboard
   * selection — the case the scroll exists for — can move the list.
   *
   * `pointermove` sets it; the browser re-runs hit testing after a scroll, so
   * `pointerleave` fires and clears it even when the pointer itself is what
   * stayed still.
   */
  const pointerInside = useRef(false);

  useEffect(() => {
    if (selected && !pointerInside.current) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <button
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      onPointerMove={(e) => {
        if (e.pointerType === 'touch') return;
        pointerInside.current = true;
        onHover?.();
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
      }}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
        // Coarse pointers get a 44px-tall target without changing the desktop
        // rhythm — the rows are 32px on a mouse.
        'min-h-8 [@media(pointer:coarse)]:min-h-11',
        selected ? 'bg-primary/[0.06]' : 'hover:bg-primary/[0.04]',
        className,
      )}
    >
      {children}
    </button>
  );
}
