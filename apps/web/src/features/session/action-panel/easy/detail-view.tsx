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
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
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
  /** Move between sibling deliverables without going home (W10). Only set
   *  when 2+ openable siblings exist — a lone file gets no nav row. */
  nav?: { prev: (() => void) | null; next: (() => void) | null; position: string };
}

/**
 * The prev/next row, shared by the desktop card and the mobile drawer so the
 * two never drift. Both pin it as a slim bar under the scrollable body —
 * `shrink-0` so it's always in view, never scrolled away with the content —
 * because horizontal swipe is out on mobile: vaul already owns the drawer's
 * vertical gesture, and layering a horizontal recognizer inside it is a
 * conflict trap. The buttons carry mobile instead.
 */
function DetailNav({ nav }: { nav: NonNullable<Detail['nav']> }) {
  return (
    <div className="border-border flex shrink-0 items-center justify-end gap-0.5 border-t px-2 py-1">
      <span className="text-muted-foreground mr-1 text-xs tabular-nums">{nav.position}</span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous"
        disabled={!nav.prev}
        onClick={() => nav.prev?.()}
        className="size-7 active:scale-[0.96]"
      >
        <ChevronLeft className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next"
        disabled={!nav.next}
        onClick={() => nav.next?.()}
        className="size-7 active:scale-[0.96]"
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}

/** True when the keydown originated in something that itself wants
 *  ArrowLeft/ArrowRight — the AppPreview address bar keeps its own arrows. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

/** What a Tab press can land on inside the dialog. Standard selector — no
 *  dependency needed for a list this short. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Desktop-only keyboard for the open detail — ArrowLeft/Right walks siblings,
 * Escape closes back to home, and Tab wraps inside the dialog while focus is
 * IN the dialog (the inert home blocks the backward walk into the dimmed
 * cards, this blocks the forward one; focus elsewhere — the chat stays live
 * beside the panel — tabs as normal, untouched). One document listener
 * carries all three: a focused-element listener would miss most of the
 * detail's body, since that body can put focus anywhere — a code block, an
 * iframe's surrounding chrome, a button — same reasoning as the reference
 * browser chrome this pages next to. Desktop-only because mobile is a vaul
 * drawer, which already owns Escape/swipe-down itself; a second listener
 * there would double-fire.
 */
function useDetailKeyboard(
  detail: Detail | null,
  isMobile: boolean,
  onBack: () => void,
  detailRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    if (isMobile || !detail) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Tab wraps even from inputs — a text field mid-dialog must not be a
      // hole in the containment — so it's checked before the typing guard.
      // Only while focus is inside the dialog, though: the trap is
      // panel-scoped, and a Tab pressed over in the chat is none of its
      // business.
      if (event.key === 'Tab') {
        const dialog = detailRef.current;
        const active = document.activeElement as HTMLElement | null;
        if (!dialog || !active || !dialog.contains(active)) return;
        // Skip hidden controls (offsetParent === null) — arbitrary tool
        // content can render collapsed/hidden buttons, and a hidden `last`
        // would break the wrap.
        const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null,
        );
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) {
          // Nothing tabbable inside: the container itself is the only stop.
          event.preventDefault();
        } else if (event.shiftKey && (active === first || active === dialog)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      // The AppPreview address bar (and anything else typing-shaped) owns
      // its own Arrow/Escape handling — e.g. its Escape resets-and-blurs.
      if (isTypingTarget(event.target)) return;
      if (event.key === 'Escape') {
        onBack();
        return;
      }
      const nav = detail.nav;
      if (!nav) return;
      if (event.key === 'ArrowLeft' && nav.prev) nav.prev();
      else if (event.key === 'ArrowRight' && nav.next) nav.next();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [detail, isMobile, onBack, detailRef]);
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
  const detailRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  // Desktop only — mobile has no keyboard to speak of, and the drawer's own
  // buttons (plus vaul's own Escape/swipe handling) carry it instead (see
  // `DetailNav`'s comment).
  useDetailKeyboard(detail, isMobile, onBack, detailRef);

  // Focus rides the layer: in on open (so Escape and the arrows work
  // immediately, and keyboard focus can never remain inside the aria-hidden
  // home), back to the invoking control on close. Keyed on `detail?.key` so
  // paging to a sibling (nav) re-focuses the fresh container — but capture
  // and restore happen ONLY on the closed↔open edges (`wasOpenRef`): a nav
  // step re-runs this effect while the old container is mid-unmount, and
  // re-capturing `document.activeElement` then would overwrite the invoking
  // row with a dying node, losing the way home. Harmless on mobile: the
  // desktop `detailRef` never mounts there, so `.focus()` no-ops.
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = detail !== null;
    if (detail) {
      if (!wasOpen) {
        restoreFocusRef.current = document.activeElement as HTMLElement | null;
      }
      requestAnimationFrame(() => detailRef.current?.focus());
    } else if (wasOpen) {
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    }
  }, [detail?.key]);

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
            {/* Pinned below the drawer body — same row the desktop card
                shows, so paging reads as one behavior wherever you are. */}
            {detail?.nav && <DetailNav nav={detail.nav} />}
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  const open = detail !== null;

  return (
    <div className="relative h-full w-full shrink-0">
      {/* Home. Slides a short way left and dims — present, just behind.
          `inert` (native, zero-dependency) is what actually keeps it out of
          the tab order and find-in-page while hidden — `aria-hidden` alone
          only hides it from assistive tech, and `pointer-events-none` only
          blocks the mouse; neither stops Shift+Tab walking backward into it
          from the freshly-focused detail. */}
      <motion.div
        animate={open ? { x: '-12%', opacity: 0 } : { x: 0, opacity: 1 }}
        transition={transition}
        className={cn('h-full w-full', open && 'pointer-events-none')}
        aria-hidden={open}
        inert={open || undefined}
      >
        {children}
      </motion.div>

      <AnimatePresence>
        {detail && (
          <motion.div
            key={detail.key}
            // No aria-modal: the detail replaces only the panel's cards — the
            // chat beside it stays live, so claiming page modality would lie
            // to assistive tech. Containment is panel-scoped instead (inert
            // home + the Tab wrap scoped to focus inside this dialog).
            role="dialog"
            aria-label={detail.title}
            tabIndex={-1}
            ref={detailRef}
            initial={reduce ? { opacity: 0 } : { x: '100%' }}
            animate={reduce ? { opacity: 1 } : { x: 0 }}
            exit={reduce ? { opacity: 0 } : { x: '100%' }}
            transition={transition}
            // Inset from the top, left and bottom — the detail is a card
            // sitting IN the panel, not a sheet nailed over it, and the gap is
            // what says so. It stays flush to the right edge (and rounds only
            // its left corners) so the slide-in reads as arriving from off-panel
            // rather than as a box that materializes in place.
            className="bg-popover border-border absolute inset-y-3 right-3 left-3 flex min-w-0 flex-col overflow-hidden rounded-md border shadow"
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
            {detail.nav && <DetailNav nav={detail.nav} />}
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
  // A step's own icon already went red for this (StepIcon, ContextCard) — but
  // that badge is one glance from the panel's home. Once the user has actually
  // opened the failed step, the detail must say so too, not just show a tool
  // view that looks the same as a success (W7).
  const failed = visible.some(
    (part) => (part.state as { status?: string } | undefined)?.status === 'error',
  );

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
        {failed && (
          <div className="border-kortix-red/30 bg-kortix-red/5 text-foreground rounded-md border px-3 py-2 text-sm">
            This step hit a problem — the details below show what happened.
          </div>
        )}
        {visible.map((part) => (
          <ToolPartRenderer key={part.callID} part={part} sessionId={sessionId} defaultOpen />
        ))}
      </div>
    </ToolSurfaceContext.Provider>
  );
}
