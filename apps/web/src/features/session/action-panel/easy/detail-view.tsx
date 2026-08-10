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
import Hint from '@/components/ui/hint';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import { focusWithoutScroll } from '@/lib/utils/focus-without-scroll';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import type { ToolPart } from '@/ui';
import {
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
  SidebarSimpleIcon as PanelLeft,
  XIcon as X,
} from '@phosphor-icons/react';
import {
  AnimatePresence,
  m,
  type TargetAndTransition,
  type Transition,
  useReducedMotion,
} from 'motion/react';
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
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

// zustand v5's own hook feeds React's `useSyncExternalStore` a
// `getServerSnapshot` pinned to `getInitialState()` (see `app-preview.tsx`'s
// `getSandboxAliveSnapshot` for the full explanation) — under
// `renderToStaticMarkup` that would make `DetailSidebarToggle`'s fullscreen
// gate permanently read the store's pristine `isExpanded: false`, no matter
// what a test's `setState` call says. Reading through `getState()` for both
// snapshots sidesteps that — same live value, same reactivity via
// `subscribe`, no behavior change in the browser or real SSR.
function useFullscreenSnapshot(): boolean {
  return useSyncExternalStore(
    useKortixComputerStore.subscribe,
    () => useKortixComputerStore.getState().isExpanded,
    () => useKortixComputerStore.getState().isExpanded,
  );
}

/**
 * The shell's floating sidebar toggle (workspace-shell.tsx / session-layout.tsx)
 * gets painted over while the detail view is fullscreen — the panel subtree
 * elevates to z-[35] to sit above it (see session-layout.tsx). So fullscreen
 * needs its OWN reopen control, living inside the detail instead — this is
 * it. Self-gating: it renders null whenever any of its conditions don't
 * hold, so every call site can mount it unconditionally.
 *
 * Shown whenever the detail is fullscreen, regardless of the sidebar's own
 * state: collapsed → opens it (with the same hover-peek the floating toggle
 * offers), open/docked → collapses it. One button, one place, always the
 * opposite of whatever the sidebar currently is.
 *
 * `useOptionalSidebar` (not `useSidebar`) on purpose — the Easy panel also
 * mounts on /debug/tools, which has no `SidebarProvider`, and `useSidebar`
 * throws outside one.
 */
export function DetailSidebarToggle({ className }: { className?: string }) {
  const panelFullscreen = useFullscreenSnapshot();
  const isMobile = useIsMobile();
  const sidebar = useOptionalSidebar();

  if (!panelFullscreen || isMobile || !sidebar) return null;

  const { state, toggleSidebar, peek, peekEnter, peekLeave } = sidebar;
  // Owner direction (supersedes the show-in-every-state round): the docked
  // sidebar carries its own collapse control in its header, so a second one
  // inside the detail would be a duplicate — the in-detail toggle exists only
  // to REOPEN a collapsed sidebar the fullscreen detail is painting over.
  if (state === 'expanded') return null;

  const label = peek ? 'Pin sidebar' : 'Open sidebar';

  return (
    <Hint label={label} side="bottom">
      <Button
        type="button"
        aria-label={label}
        onClick={toggleSidebar}
        onPointerEnter={peekEnter}
        onPointerLeave={peekLeave}
        variant="ghost"
        size="icon"
        className={cn(
          'text-muted-foreground hover:text-foreground shrink-0 active:scale-[0.96]',
          className,
        )}
      >
        <PanelLeft className="cn-rtl-flip size-4" />
      </Button>
    </Hint>
  );
}

/**
 * The card frame both layers wear — the detail card and the persistent layer.
 * ONE constant, because they are two states of one shell: inset from the top,
 * left and bottom so the card reads as sitting IN the panel rather than nailed
 * over it, flush to the right edge so an arrival slides in from off-panel.
 *
 * This used to be copy-pasted into `easy-panel.tsx`'s standalone terminal
 * `m.div`, which is exactly how the terminal drifted into looking like its
 * own sidebar instead of a view inside this shell. Shared, the two cannot drift.
 */
const CARD_FRAME =
  'bg-popover border-border absolute inset-y-3 right-3 left-3 flex min-w-0 flex-col overflow-hidden rounded-md border shadow';

/**
 * A layer that lives inside the detail card frame but must NEVER unmount.
 *
 * The terminal is the only one: `SessionTerminalPanel` owns a long-lived PTY
 * WebSocket, and the keyed `AnimatePresence` below tears a `Detail`'s body down
 * on every close — correct for a file preview, fatal for a live shell (the
 * connection drops and scrollback replays on reopen). So this layer is mounted
 * once, on first open, and thereafter animated between the same two resting
 * states a detail moves between, staying mounted with `inert` + zero opacity
 * while closed.
 *
 * It is mutually exclusive with `detail` — the owner closes one to open the
 * other — and `swap` records which edge the current toggle crossed, since at
 * render time an open layer with a null detail cannot tell "arrived from home"
 * (slide) from "replaced a detail" (crossfade). See `terminalLayerMotion`.
 *
 * Desktop only. On mobile the panel is already a bottom drawer, so the terminal
 * comes up as its own drawer instead and this prop is ignored.
 */
export interface PersistentLayer {
  open: boolean;
  swap: boolean;
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  body: ReactNode;
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
  /**
   * This detail arrived by REPLACING the open terminal layer, not by arriving
   * from home — a sibling swap inside the same visual frame, so the card must
   * not replay the arrival slide. It appears instantly UNDER the terminal,
   * whose own fade-out above it carries the whole crossfade (see
   * `detailCardVariants`/`terminalLayerMotion`). Stamped by `EasyPanel`'s
   * `openDetail`, the one funnel that knows whether the terminal was up.
   */
  swapIn?: boolean;
  /**
   * Reads like a capability ("this detail will measure itself") but is
   * actually a lifecycle instruction to `openDetail`: "do not clear
   * `panelAspect`". Set when this detail's body will report its own
   * intrinsic size (see `reportsIntrinsicSize` in `file-preview.tsx`), so
   * `openDetail` leaves the store's `panelAspect` alone instead of clearing
   * it, trusting the incoming report to replace it.
   *
   * Without this, paging between two A4 PDFs glides the panel down to the
   * default column and straight back up again — a 123px round trip between
   * two pages of the same report. Holding the outgoing ratio until the
   * incoming document replaces it makes same-shape paging perfectly still and
   * shape-changing paging exactly one glide. Everything that reports nothing
   * (a deck, an app, a step, Audit, a text file) leaves this unset and clears
   * as before, because for those the ratio has genuinely stopped being true.
   */
  measures?: boolean;
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
export const SLIDE_TRANSITION = { duration: DURATION, ease: EASE } as const;

/**
 * Motion: paging to a sibling deliverable is not a re-arrival — the card
 * already IS there, only what's inside it changed. So the slide never plays
 * again; the header+body+nav just crossfade, fast enough to read as a swap
 * rather than a transition (130ms, ease-out — quicker than the 260ms open/
 * close slide, per the doctrine that exits/swaps stay subtler than entrances).
 */
export const CROSSFADE_TRANSITION = { duration: 0.13, ease: 'easeOut' } as const;

/**
 * The detail card's enter/exit targets, as dynamic variants over one custom
 * boolean: `swap` — the terminal layer is on the OTHER side of this edge
 * (the card is replacing it, or being replaced by it).
 *
 * A swap is a sibling exchange inside the same visual frame, so it borrows
 * the nav-crossfade language, not the arrival slide. And because both layers
 * are fully opaque cards, only ONE of them may fade or the home bleeds
 * through the midpoint: the terminal — painted above the card by DOM order —
 * owns the whole 130ms fade (see `terminalLayerMotion`), while the card just
 * appears/disappears at full opacity underneath at the right moment: enter
 * lands instantly under the fading-out terminal; exit holds until the
 * fading-in terminal fully covers it, then leaves.
 *
 * `swap` reaches the variants two ways: the element's own `custom` (stamped
 * from `Detail.swapIn`, read at mount for the enter) and `AnimatePresence`'s
 * `custom` (the live `terminalOpen`, which motion swaps in for the exit —
 * the element's last-rendered props predate the state flip that removed it).
 *
 * Exported for tests; pure so the choreography is checkable without a DOM.
 */
export function detailCardVariants(reduce: boolean) {
  const slide = reduce ? ({ duration: 0 } as const) : SLIDE_TRANSITION;
  return {
    hidden: (swap: boolean): TargetAndTransition =>
      swap
        ? {
            opacity: 0,
            transition: { duration: 0, delay: reduce ? 0 : CROSSFADE_TRANSITION.duration },
          }
        : reduce
          ? { opacity: 0, transition: { duration: 0 } }
          : { x: '100%', transition: slide },
    visible: (swap: boolean): TargetAndTransition => ({
      x: 0,
      opacity: 1,
      transition: swap ? { duration: 0 } : slide,
    }),
  };
}

/**
 * The terminal layer's animate target + transition for its four edges. The
 * layer is keep-alive (never unmounted — it owns a live PTY WebSocket), so
 * instead of `AnimatePresence` it converges on one of two resting states —
 * open `{x: 0, opacity: 1}` / closed `{x: '100%', opacity: 0}` — and the
 * `swap` flag picks which property carries the motion between them:
 *
 * - home ↔ terminal (`swap` false): the same 260ms slide the detail card
 *   plays — going one level deeper is one motion language, whatever the
 *   layer. Opacity snaps while the layer is off-panel (clipped, invisible
 *   anyway): instantly to 1 before a slide-in, to 0 only AFTER a slide-out.
 * - detail ↔ terminal (`swap` true): the 130ms crossfade, which this layer
 *   carries alone (see `detailCardVariants`). x teleports while invisible —
 *   instantly into place before a fade-in, off-panel only after a fade-out.
 *
 * Reduced motion keeps the comprehension fade on swaps but snaps the slides
 * (movement is what reduced motion asks to lose, not state changes).
 *
 * Exported for tests; pure for the same reason as `detailCardVariants`.
 */
export function terminalLayerMotion(
  open: boolean,
  swap: boolean,
  reduce: boolean,
): { target: TargetAndTransition; transition: Transition } {
  const target: TargetAndTransition = open ? { x: 0, opacity: 1 } : { x: '100%', opacity: 0 };
  if (swap || reduce) {
    const fade = reduce ? ({ duration: 0 } as const) : CROSSFADE_TRANSITION;
    return {
      target,
      transition: open
        ? { ...fade, x: { duration: 0 } }
        : { ...fade, x: { duration: 0, delay: reduce ? 0 : CROSSFADE_TRANSITION.duration } },
    };
  }
  return {
    target,
    transition: open
      ? { ...SLIDE_TRANSITION, opacity: { duration: 0 } }
      : { ...SLIDE_TRANSITION, opacity: { duration: 0, delay: DURATION } },
  };
}

export function DetailLayer({
  detail,
  onBack,
  isMobile,
  persistentLayer,
  children,
}: {
  detail: Detail | null;
  onBack: () => void;
  isMobile: boolean;
  /** The keep-alive layer (the terminal) this shell hosts alongside `detail`.
   *  The home slides/dims/inerts for it exactly as it does for a detail — it's
   *  the same "one level down" — and a detail card exiting while it is open
   *  fades under it instead of sliding home (see `detailCardVariants`).
   *  Desktop only; see {@link PersistentLayer}. */
  persistentLayer?: PersistentLayer;
  /** The home view. Empty on desktop since the cards moved to the floating
   *  overlay; still the three cards on mobile, where panel and overlay are one
   *  drawer. */
  children?: ReactNode;
}) {
  const reduce = useReducedMotion();
  const persistentOpen = !!persistentLayer?.open;
  const transition = reduce ? { duration: 0 } : SLIDE_TRANSITION;
  const crossfadeTransition = reduce ? { duration: 0 } : CROSSFADE_TRANSITION;
  const cardVariants = detailCardVariants(!!reduce);
  const detailRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  // Desktop only — mobile has no keyboard to speak of, and the drawer's own
  // buttons (plus vaul's own Escape/swipe handling) carry it instead (see
  // `DetailNav`'s comment).
  useDetailKeyboard(detail, isMobile, onBack, detailRef);

  // Once-true latch: the persistent layer costs nothing until it is first
  // asked for (no PTY is opened for a user who never opens the terminal), and
  // from then on it stays mounted forever. Deliberately never reset — that is
  // the entire contract of a keep-alive layer.
  //
  // Adjusted DURING render, not in an effect. React's sanctioned
  // "storing information from previous renders" pattern: it re-renders
  // immediately with the new value before committing anything to the DOM, so
  // the layer exists on the very first render where `open` is true and its
  // arrival animation starts on that frame. The effect form this replaces
  // (which `easy-panel.tsx` used) always landed one frame late, because the
  // layer could not mount until after the effect had run.
  const [persistentActivated, setPersistentActivated] = useState(false);
  if (persistentOpen && !persistentActivated) setPersistentActivated(true);

  // Focus rides the layer: in on open (so Escape and the arrows work
  // immediately, and keyboard focus can never remain inside the aria-hidden
  // home), back to the invoking control on close. Keyed on `detail?.key` so
  // paging to a sibling (nav) re-focuses the container — the card itself no
  // longer remounts on a nav step (only its inner content crossfades), but
  // focus should still land back on it each time, the same as it would if it
  // had. Capture and restore happen ONLY on the closed↔open edges
  // (`wasOpenRef`): a nav step re-runs this effect too, and re-capturing
  // `document.activeElement` then would overwrite the invoking row with
  // whatever the nav button itself was, losing the way home. Harmless on
  // mobile: the desktop `detailRef` never mounts there, so `.focus()` no-ops.
  // Both focuses go through `focusWithoutScroll`: they land while a layer is
  // still translated by the slide (card entering at x:100%, home returning
  // from -12%), and a bare focus() scrolls the panel's overflow-hidden
  // ancestors sideways to "reveal" it — permanently, once the keep-alive
  // terminal layer's parked x:100% keeps the overflow from shrinking back.
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = detail !== null;
    if (detail) {
      if (!wasOpen) {
        restoreFocusRef.current = document.activeElement as HTMLElement | null;
      }
      requestAnimationFrame(() => focusWithoutScroll(detailRef.current));
    } else if (wasOpen) {
      focusWithoutScroll(restoreFocusRef.current);
      restoreFocusRef.current = null;
    }
  }, [detail?.key]);

  // Mobile: the panel is already a bottom drawer. Stack a drawer, not a slide.
  // (Dev-tool quick views never come through here on mobile — they open the
  // standalone `MobileToolDrawer` instead; this path is for the panel's own
  // details: outputs, steps, context rows.)
  if (isMobile) {
    return (
      <>
        {children}
        <Drawer open={detail !== null} onOpenChange={(next) => !next && onBack()}>
          <DrawerContent className="flex h-[85dvh] max-h-[85dvh] flex-col overflow-hidden p-0">
            {/* The drawer itself never closes/reopens on paging — only its
                content crossfades, same principle as the desktop card below.
                `initial={false}` skips the fade on the drawer's own open
                (vaul's slide-up already carries that arrival); `popLayout`
                lets the fresh content take over the flow immediately instead
                of stacking under the outgoing one mid-fade. */}
            <AnimatePresence mode="popLayout" initial={false}>
              <m.div
                key={detail?.key ?? 'empty'}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={crossfadeTransition}
                className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              >
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
              </m.div>
            </AnimatePresence>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  const open = detail !== null;
  // The home is "one level up" from a detail AND from the persistent layer —
  // it hides for either, with the same motion, so the two layers read as
  // siblings in one place rather than two unrelated overlays.
  const covered = open || persistentOpen;
  const persistentMotion = terminalLayerMotion(
    persistentOpen,
    !!persistentLayer?.swap,
    !!reduce,
  );

  return (
    <div className="relative h-full w-full shrink-0">
      {/* Home. Slides a short way left and dims — present, just behind.
          `inert` (native, zero-dependency) is what actually keeps it out of
          the tab order and find-in-page while hidden — `aria-hidden` alone
          only hides it from assistive tech, and `pointer-events-none` only
          blocks the mouse; neither stops Shift+Tab walking backward into it
          from the freshly-focused detail. */}
      <m.div
        animate={covered ? { x: '-12%', opacity: 0 } : { x: 0, opacity: 1 }}
        transition={transition}
        className={cn('h-full w-full', covered && 'pointer-events-none')}
        aria-hidden={covered}
        inert={covered || undefined}
      >
        {children}
      </m.div>

      <AnimatePresence custom={persistentOpen}>
        {detail && (
          <m.div
            // Constant key: this is the CARD, and paging between siblings
            // never rebuilds it — only opening (mount) and closing (unmount)
            // do, which is what earns the slide. A key on `detail.key` here
            // would make AnimatePresence replay the arrival on every nav
            // click, which is exactly the bug this layer split fixes.
            key="detail-card"
            // No aria-modal: the detail replaces only the panel's cards — the
            // chat beside it stays live, so claiming page modality would lie
            // to assistive tech. Containment is panel-scoped instead (inert
            // home + the Tab wrap scoped to focus inside this dialog).
            role="dialog"
            aria-label={detail.title}
            tabIndex={-1}
            ref={detailRef}
            // Enter/exit via `detailCardVariants`: slide against home,
            // opacity-timed swap against the terminal layer. The element
            // custom carries the arrival's swap flag (stamped on the Detail);
            // AnimatePresence's own `custom` above overrides it with the live
            // `terminalOpen` for the exit, since the exiting card's last
            // rendered props predate the state flip that removed it.
            custom={!!detail.swapIn}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            // `CARD_FRAME` is shared with the persistent layer below, so the
            // two states of this shell can never drift apart visually.
            // `outline-none`: this container is programmatically focused on
            // open (the a11y focus management above). A keyboard-initiated
            // open — the ⌘K "Open Browser"/"Open Terminal" commands — makes
            // that focus :focus-visible, which drew a focus ring around the
            // whole card. The container is a focus TARGET (tabIndex -1), not
            // a control; its frame is the border, never an outline.
            className={cn(CARD_FRAME, 'outline-none')}
          >
            {/* The content layer: keyed on `detail.key`, so paging to a
                sibling swaps THIS, not the card above. `popLayout` pulls the
                outgoing content out of flow (position: absolute) the instant
                the new one arrives, so the incoming content owns the height
                immediately instead of the two stacking and shoving the card
                tall for a frame. `initial={false}` skips the fade on the
                card's own open — the slide above already carries that
                arrival — and only animates key changes after that, i.e. nav. */}
            <AnimatePresence mode="popLayout" initial={false}>
              <m.div
                key={detail.key}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={crossfadeTransition}
                className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              >
                {!detail.hideHeader && (
                  // No rule under the header: the card's own border already
                  // separates this from the panel, and a second line inside it just
                  // boxes the title in. Close sits far right, where a close always
                  // is — a back chevron implies a stack the user isn't in.
                  <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <DetailSidebarToggle className="size-7" />
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
              </m.div>
            </AnimatePresence>
          </m.div>
        )}
      </AnimatePresence>

      {/* The keep-alive layer. A LATER sibling of the detail's AnimatePresence
          on purpose: with no explicit z-index, DOM order alone paints it above
          the detail card, which is what lets it carry BOTH swap crossfades —
          it fades in over an exiting detail and fades out over an arriving one
          (see `terminalLayerMotion`/`detailCardVariants`; only one of two
          opaque cards may fade, or the home bleeds through the midpoint).
          Never unmounted once activated, so its PTY WebSocket survives every
          close. `initial` is the closed resting state, so the first-ever
          activation plays the same arrival every later open does. */}
      {persistentActivated && persistentLayer && (
        <m.div
          initial={{ x: '100%', opacity: 0 }}
          animate={persistentMotion.target}
          transition={persistentMotion.transition}
          aria-hidden={!persistentOpen}
          inert={!persistentOpen || undefined}
          className={cn(CARD_FRAME, !persistentOpen && 'pointer-events-none')}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
            <span className="flex min-w-0 items-center gap-2">
              <DetailSidebarToggle className="size-7" />
              {persistentLayer.icon}
              <span className="text-foreground truncate text-sm font-semibold">
                {persistentLayer.title}
              </span>
            </span>
            <CloseButton onClose={persistentLayer.onClose} />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">{persistentLayer.body}</div>
        </m.div>
      )}
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
