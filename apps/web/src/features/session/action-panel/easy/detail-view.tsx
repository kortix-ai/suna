'use client';

/**
 * The one place Easy mode shows detail.
 *
 * It is NOT an overlay. On desktop the detail *replaces* the three cards
 * inside the panel: the cards slide out to the left as the detail slides in
 * from the right, and Back reverses it. That's a parent/child relationship —
 * you went one level deeper into the same surface — which is exactly what
 * happened, and it reads as one continuous place rather than a dialog that
 * happens to be floating above another dialog.
 *
 * On mobile the panel is already a bottom drawer, so a second horizontal layer
 * inside it would be a maze. There the detail comes up as its own drawer.
 *
 * Whatever the container, the payload is the SAME `ToolPartRenderer` the
 * Advanced stepper uses. Easy mode is a lens over the truth, never a wall.
 */

import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import type { ToolPart } from '@/ui';
import { X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { normalizeName } from '../../tool/tool-meta';
import { ToolPartRenderer, ToolSurfaceContext } from '../../tool/tool-renderers';

/** Closes the detail. Exported so a body with its own toolbar can host it. */
export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClose}
      aria-label="Close"
      className="size-7 shrink-0 active:scale-[0.96]"
    >
      <X className="size-4" />
    </Button>
  );
}

/** What the panel is currently showing one level down. */
export interface Detail {
  /** Distinguishes one detail from another so re-opening re-animates. */
  key: string;
  title: string;
  icon?: ReactNode;
  body: ReactNode;
  /**
   * Suppress the layer's own header. Some bodies bring their own toolbar (the
   * file preview names the file and owns its view toggle) — two headers stacked
   * would just be one saying the other's name back to it.
   */
  hideHeader?: boolean;
  /**
   * Body padding. Off where the body's own children already own their spacing —
   * the tool views behind a Progress step do, and padding them again just
   * squeezes code and diffs into a narrower column.
   */
  padded?: boolean;
}

/**
 * Motion: the detail arrives from the right and the home slides a short way
 * left — a partial parallax, not a full swap, so the home reads as *behind*
 * the detail rather than gone. 260ms on a soft ease-out; the eye should follow
 * the movement without waiting on it.
 */
const EASE = [0.22, 1, 0.36, 1] as const;
const DURATION = 0.26;

export function DetailLayer({
  detail,
  onBack,
  isMobile,
  children,
}: {
  detail: Detail | null;
  onBack: () => void;
  isMobile: boolean;
  /** The home view — the three cards. */
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const transition = reduce ? { duration: 0 } : { duration: DURATION, ease: EASE };

  // Mobile: the panel is already a bottom drawer. Stack a drawer, not a slide.
  if (isMobile) {
    return (
      <>
        {children}
        <Drawer open={detail !== null} onOpenChange={(next) => !next && onBack()}>
          <DrawerContent className="flex h-[85dvh] max-h-[85dvh] flex-col overflow-hidden p-0">
            {!detail?.hideHeader && (
              <DrawerHeader className="shrink-0 px-4 py-3 text-left">
                <DrawerTitle className="flex min-w-0 items-center justify-between gap-2 text-base">
                  <span className="flex min-w-0 items-center gap-2.5">
                    {detail?.icon}
                    <span className="truncate">{detail?.title}</span>
                  </span>
                  <CloseButton onClose={onBack} />
                </DrawerTitle>
              </DrawerHeader>
            )}
            <div
              className={cn(
                'min-h-0 min-w-0 flex-1 overflow-auto',
                detail?.padded !== false && 'p-4',
              )}
            >
              {detail?.body}
            </div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  const open = detail !== null;

  return (
    <div className="relative h-full w-full shrink-0">
      {/* Home. Slides a short way left and dims — present, just behind. */}
      <motion.div
        animate={open ? { x: '-12%', opacity: 0 } : { x: 0, opacity: 1 }}
        transition={transition}
        className={cn('h-full w-full', open && 'pointer-events-none')}
        aria-hidden={open}
      >
        {children}
      </motion.div>

      <AnimatePresence>
        {detail && (
          <motion.div
            key={detail.key}
            initial={reduce ? { opacity: 0 } : { x: '100%' }}
            animate={reduce ? { opacity: 1 } : { x: 0 }}
            exit={reduce ? { opacity: 0 } : { x: '100%' }}
            transition={transition}
            // Inset from the top, left and bottom — the detail is a card
            // sitting IN the panel, not a sheet nailed over it, and the gap is
            // what says so. It stays flush to the right edge (and rounds only
            // its left corners) so the slide-in reads as arriving from off-panel
            // rather than as a box that materializes in place.
            className="bg-popover border-border  absolute inset-y-3 right-3 left-3 flex min-w-0 flex-col overflow-hidden rounded-md border shadow"
          >
            {!detail.hideHeader && (
              // No rule under the header: the card's own border already
              // separates this from the panel, and a second line inside it just
              // boxes the title in. Close sits far right, where a close always
              // is — a back chevron implies a stack the user isn't in.
              <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
                <span className="flex min-w-0 items-center gap-2">
                  {detail.icon}
                  <span className="text-foreground truncate text-sm font-semibold">
                    {detail.title}
                  </span>
                </span>
                <CloseButton onClose={onBack} />
              </div>
            )}
            <div
              className={cn(
                'min-h-0 min-w-0 flex-1 overflow-auto',
                detail.padded !== false && 'p-4',
                !detail.hideHeader && detail.padded !== false && 'pt-0',
              )}
            >
              {detail.body}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Tools that re-send their ENTIRE state on every call rather than a delta. */
function isSnapshotTool(tool: string): boolean {
  const n = normalizeName(tool);
  return n === 'todo_write' || n === 'todowrite';
}

/**
 * `todo_write` doesn't append a task — it re-sends the whole checklist, every
 * time, with the statuses as they now stand. So a step that grouped three of
 * them was rendering the same list three times over (0/4, then 1/4, then 4/4)
 * and reading as three separate to-do lists. They are three photographs of one
 * list, and only the last one is still true.
 *
 * Keep the final snapshot; drop the ones it superseded. Any non-snapshot call in
 * the step is a real distinct event and survives untouched.
 */
export function collapseSnapshots(parts: ToolPart[]): ToolPart[] {
  let lastSnapshot = -1;
  parts.forEach((part, i) => {
    if (isSnapshotTool(part.tool)) lastSnapshot = i;
  });
  if (lastSnapshot < 0) return parts;
  return parts.filter((part, i) => !isSnapshotTool(part.tool) || i === lastSnapshot);
}

/** The real tool views for a set of calls — the escape hatch's payload. */
export function ToolParts({ parts, sessionId }: { parts: ToolPart[]; sessionId: string }) {
  const visible = collapseSnapshots(parts);

  return (
    <ToolSurfaceContext.Provider value="panel">
      <div
        className={cn(
          'flex min-w-0 flex-col gap-2',
          // Tool views cap their own scroll height for the inline chat, where
          // they're one item among many. Here the detail IS the tool — a web
          // search that shows 5 of its 20 results behind an inner scrollbar is
          // hiding what the user opened it to see. The detail's own container
          // scrolls instead. Same un-cap the Advanced stepper applies.
          '[&_[data-scrollable]]:max-h-none [&_[data-scrollable]]:overflow-visible',
        )}
      >
        {visible.map((part) => (
          <ToolPartRenderer key={part.callID} part={part} sessionId={sessionId} defaultOpen />
        ))}
      </div>
    </ToolSurfaceContext.Provider>
  );
}
