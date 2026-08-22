'use client';

import { SidebarSimpleIcon as PanelLeftIcon } from '@phosphor-icons/react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { createPeekController } from '@/components/ui/sidebar-peek';
import {
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  SIDEBAR_WIDTH_COOKIE_NAME,
  SIDEBAR_WIDTH_PX,
  clampSidebarWidth,
  maxSidebarWidth,
  parseSidebarWidthCookie,
} from '@/components/ui/sidebar-width';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

const SIDEBAR_COOKIE_NAME = 'sidebar_state';
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = '16rem';
const SIDEBAR_WIDTH_MOBILE = '18rem';
const SIDEBAR_WIDTH_ICON = '1.6rem';
const SIDEBAR_KEYBOARD_SHORTCUT = 'b';

/**
 * How long the panel keeps its DOCKED geometry after the sidebar collapses.
 * Mirrors `duration-[240ms]` on the container below — the timer has to outlast
 * the transform it covers, or the flyout geometry lands while the panel is
 * still on screen and you see the pop this whole mechanism exists to remove.
 * One number, two places, asserted against each other in `sidebar.test.tsx`.
 */
const SIDEBAR_UNDOCK_MS = 240;

/** Keyboard resize step on the rail. Shift multiplies it. */
const SIDEBAR_RESIZE_STEP_PX = 16;
const SIDEBAR_RESIZE_STEP_COARSE_PX = 64;

/**
 * How a toggle was triggered. Either state it (`{ instant: true }`) or hand the
 * click event straight through — a click synthesized by Enter/Space reports
 * `detail === 0`, so `onClick={toggleSidebar}` makes every keyboard-activated
 * toggle instant for free.
 */
export type SidebarToggleOptions = { instant?: boolean; detail?: number };

const resolveInstant = (options?: SidebarToggleOptions) =>
  options?.instant ?? options?.detail === 0;

type SidebarContextProps = {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: (options?: SidebarToggleOptions) => void;
  /**
   * True for the frames covering a toggle that must not animate. Set by every
   * keyboard-initiated toggle; see the note on `toggleSidebar` above.
   */
  instantToggle: boolean;
  /** Collapsed-only hover flyout: the sidebar floats over the content while
   *  the pointer is near the left edge or on the panel itself. `open` stays
   *  false the whole time, so a toggle click while peeking docks it open. */
  peek: boolean;
  peekEnter: () => void;
  peekLeave: () => void;
  /** Pin the flyout open while a menu/popover anchored in the panel is open —
   *  its content portals outside the panel, so hovering it would otherwise
   *  collapse the flyout. Balanced: `holdPeek(true)` on open, `false` on close. */
  holdPeek: (held: boolean) => void;
  /** Current docked width in px — the resolved value of `--sidebar-width`. */
  width: number;
  /** Clamp, apply, and persist a new width. One render, one cookie write. */
  setWidth: (width: number) => void;
  /**
   * Paint a width straight onto the wrapper's CSS variable, with no React
   * render. Used for the duration of a rail drag; `setWidth` then commits the
   * final value once on pointer-up.
   */
  previewWidth: (width: number) => void;
};

export const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.');
  }

  return context;
}

/** Same context as `useSidebar`, but returns `null` outside a
 *  `SidebarProvider` instead of throwing. For callers that can genuinely
 *  render on both sides of the boundary — e.g. the Easy panel, which also
 *  mounts on /debug/tools with no provider at all. */
function useOptionalSidebar() {
  return React.useContext(SidebarContext);
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === 'function' ? value(open) : value;
      if (setOpenProp) {
        setOpenProp(openState);
      } else {
        _setOpen(openState);
      }

      // This sets the cookie to keep the sidebar state.
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
    },
    [setOpenProp, open],
  );

  // Helper to toggle the sidebar.
  //
  // ⌘B — and any Enter/Space activation of a toggle button — is a
  // keyboard-initiated action on a surface the user hits many times a day, and
  // those get NO motion. The frequency rule is not about the number of
  // milliseconds; it is about the hand expecting the panel to already be there
  // when the fingers come off the keys.
  const [instantToggle, setInstantToggle] = React.useState(false);
  const toggleSidebar = React.useCallback(
    (options?: SidebarToggleOptions) => {
      setInstantToggle(resolveInstant(options));
      return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open);
    },
    [isMobile, setOpen, setOpenMobile],
  );

  // Release the instant flag once the browser has painted the snapped frame, so
  // the NEXT pointer-driven toggle animates again. Double rAF, not a timeout: a
  // `setTimeout(0)` can land before the paint, which would re-declare the
  // transition while the transform is still mid-change and animate the very
  // toggle that asked not to be animated.
  React.useEffect(() => {
    if (!instantToggle) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setInstantToggle(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [instantToggle]);

  // Edge-peek flyout state — hover intent lives in a plain controller so the
  // open/close delays are testable without React or wall-clock timers.
  const [peek, setPeek] = React.useState(false);
  const peekController = React.useMemo(() => createPeekController(setPeek), []);
  React.useEffect(() => () => peekController.cancel(), [peekController]);
  React.useEffect(() => {
    if (open || isMobile) peekController.cancel();
  }, [open, isMobile, peekController]);

  // Tracks whether the pointer is currently over the panel/edge zone so a
  // menu closing can decide whether to re-arm the flyout's close timer.
  const pointerOverRef = React.useRef(false);
  const peekEnter = React.useCallback(() => {
    pointerOverRef.current = true;
    peekController.enter();
  }, [peekController]);
  const peekLeave = React.useCallback(() => {
    pointerOverRef.current = false;
    peekController.leave();
  }, [peekController]);
  const holdPeek = React.useCallback(
    (held: boolean) => peekController.hold(held, () => pointerOverRef.current),
    [peekController],
  );

  // ── Resizable width ────────────────────────────────────────────────────
  // `null` means "use the default"; a number is the user's persisted choice.
  // Read straight out of the cookie in the initializer so a resized sidebar
  // never paints at 256px first and then jumps — the wrapper below carries
  // `suppressHydrationWarning` because that read makes the client's first
  // style attribute legitimately differ from the server's.
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidthState] = React.useState<number | null>(() =>
    typeof document === 'undefined' ? null : parseSidebarWidthCookie(document.cookie),
  );

  const setWidth = React.useCallback((next: number) => {
    const clamped = clampSidebarWidth(next, window.innerWidth);
    // Write the committed value to the node BEFORE the state update, and never
    // clear the override. A drag leaves an inline `--sidebar-width` on the
    // wrapper; removing it here would paint one frame at the default 16rem if
    // React defers the re-render past the next paint. Writing the same value
    // React is about to render makes the hand-off unobservable.
    wrapperRef.current?.style.setProperty('--sidebar-width', `${clamped}px`);
    setWidthState(clamped);
    document.cookie = `${SIDEBAR_WIDTH_COOKIE_NAME}=${clamped}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
  }, []);

  // Live drag feedback without a React render per pointermove. The gap and the
  // panel both size off this one variable, so writing it on the wrapper node
  // IS the update. (Custom properties inherit, so this does cost a style
  // recalc down the tree — acceptable for a drag the user is watching, and the
  // reason it is not used for anything else.)
  const previewWidth = React.useCallback((next: number) => {
    wrapperRef.current?.style.setProperty('--sidebar-width', `${next}px`);
  }, []);

  // The ratio cap is a live rule, not a write-time one: a stored 416px must
  // not survive the window being dragged down to 900px. Runs once on mount too,
  // which is what re-clamps a value persisted at a wider viewport.
  React.useEffect(() => {
    const capToViewport = () =>
      setWidthState((current) => {
        if (current === null) return current;
        const capped = Math.min(current, maxSidebarWidth(window.innerWidth));
        return capped === current ? current : capped;
      });
    capToViewport();
    window.addEventListener('resize', capToViewport);
    return () => window.removeEventListener('resize', capToViewport);
  }, []);

  // Adds a keyboard shortcut to toggle the sidebar.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar({ instant: true });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar]);

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? 'expanded' : 'collapsed';

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
      instantToggle,
      peek,
      peekEnter,
      peekLeave,
      holdPeek,
      width: width ?? SIDEBAR_WIDTH_PX,
      setWidth,
      previewWidth,
    }),
    [
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
      instantToggle,
      peek,
      peekEnter,
      peekLeave,
      holdPeek,
      width,
      setWidth,
      previewWidth,
    ],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delayDuration={0}>
        <div
          data-slot="sidebar-wrapper"
          suppressHydrationWarning
          style={
            {
              '--sidebar-width': width === null ? SIDEBAR_WIDTH : `${width}px`,
              '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            'group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar flex min-h-svh w-full',
            className,
          )}
          {...props}
          ref={wrapperRef}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  side = 'left',
  variant = 'sidebar',
  collapsible = 'offcanvas',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  side?: 'left' | 'right';
  variant?: 'sidebar' | 'floating' | 'inset';
  collapsible?: 'offcanvas' | 'icon' | 'none';
}) {
  const { isMobile, state, openMobile, setOpenMobile, peek, peekEnter, peekLeave, instantToggle } =
    useSidebar();
  const slides = collapsible === 'offcanvas' && side === 'left';
  const peekable = slides && state === 'collapsed';
  const peeking = peekable && peek;

  // `undocking` is the transient frame-window right after a collapse, during
  // which the panel is still on screen and sliding out. It is derived DURING
  // RENDER, not in an effect: an effect would commit one frame in the flyout
  // geometry first, and that single frame is exactly the pop the user reads as
  // "it just disappeared". React re-renders from this before it paints.
  const [renderedState, setRenderedState] = React.useState(state);
  const [collapseStarted, setCollapseStarted] = React.useState(false);
  if (renderedState !== state) {
    setRenderedState(state);
    // An instant toggle skips the undocking window entirely — there is no
    // slide for the docked geometry to survive.
    setCollapseStarted(slides && state === 'collapsed' && !instantToggle);
  }
  React.useEffect(() => {
    if (!collapseStarted) return;
    const id = setTimeout(() => setCollapseStarted(false), SIDEBAR_UNDOCK_MS);
    return () => clearTimeout(id);
  }, [collapseStarted]);

  // A hover on the edge strip mid-collapse wins: the user asked for the panel
  // back before it finished leaving, so hand it to the flyout.
  const undocking = collapseStarted && !peek;
  // The two boxes the panel can occupy. Docked and undocking share the flush
  // full-height one; parked and peeking share the inset flyout card.
  const flyout = peekable && !undocking;
  // Everything that is not "on screen at rest" parks at the same transform, so
  // the parked → undocking hand-off changes no value and starts no animation.
  const offscreen = state === 'collapsed' && !peeking;

  if (collapsible === 'none') {
    return (
      <div
        data-slot="sidebar"
        className={cn(
          'bg-sidebar text-sidebar-foreground flex h-full w-(--sidebar-width) flex-col',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          className="bg-sidebar text-sidebar-foreground w-(--sidebar-width) p-0 [&>button]:hidden"
          style={
            {
              '--sidebar-width': SIDEBAR_WIDTH_MOBILE,
            } as React.CSSProperties
          }
          side={side}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Displays the mobile sidebar.</SheetDescription>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className="group peer text-sidebar-foreground hidden md:block"
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      data-variant={variant}
      data-side={side}
      data-peek={peeking ? '' : undefined}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop. Its width snaps —
          it must NOT transition. This box is what pushes the content over, so
          animating its width reflows the entire page subtree (resizable panel
          group, virtualized message list) on every frame for the whole
          duration. Docking is a one-frame layout change instead. */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          'relative w-(--sidebar-width) bg-transparent',
          'group-data-[collapsible=offcanvas]:w-0',
          'group-data-[side=right]:rotate-180',
          variant === 'floating' || variant === 'inset'
            ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
        )}
      />
      <div
        data-slot="sidebar-container"
        data-motion={
          slides
            ? state === 'expanded'
              ? 'docked'
              : undocking
                ? 'undocking'
                : peeking
                  ? 'peeking'
                  : 'parked'
            : undefined
        }
        onPointerEnter={peekable ? peekEnter : undefined}
        onPointerLeave={peekable ? peekLeave : undefined}
        className={cn(
          'fixed z-10 hidden w-(--sidebar-width) md:flex',
          // ─────────────────────────────────────────────────────────────────
          // THE RULE, and it governs every branch below:
          //   layout resolves in one frame; only `transform` is ever animated.
          //
          // The content pane reclaims (or gives up) its 16rem in a single
          // reflow at t=0. That reflow is free to be visible only because it
          // happens UNDER this panel: at t=0 the panel still covers the exact
          // strip the pane just grew into, so the collapse reads as the panel
          // sliding off and uncovering content that was already there. On the
          // way back the strip it uncovers is `bg-sidebar` on a `bg-sidebar`
          // wrapper, so the band ahead of the incoming panel is seamless and
          // only the panel's CONTENT appears to slide in.
          //
          // Corollary — geometry only ever changes while the panel is
          // off-screen. Docked and undocking share the flush, full-height,
          // square box; parked and peeking share the inset flyout card. The
          // swap between the two therefore always lands on a frame where the
          // panel is fully translated out of view. This is what the previous
          // revision could not do: it swapped geometry at t=0, in full view,
          // and the resulting pop is why collapsing read as instant even
          // though a 220ms slide was running underneath it.
          //
          // OPENING IS NOT ANIMATED, from any trigger. A transition is read off
          // the destination style, so the docked branch simply declares none
          // and the panel, its contents, and the reflowed content pane all
          // land on the same frame. Sliding the panel in looked considered and
          // was not: the wrapper behind it is already `bg-sidebar`, so the
          // background arrived instantly while the panel's CONTENT trailed
          // 300ms behind it, and the whole open read as laggy.
          //
          // Timing on the branches that DO animate is asymmetric: undocking
          // 240ms, peek-in 260ms, peek-out 200ms, all on the iOS sheet curve.
          // ─────────────────────────────────────────────────────────────────
          slides
            ? cn(
                // Above the content headers for the whole collapsed
                // lifecycle, so the exit slide is never clipped by one.
                state === 'collapsed' && 'z-40',
                // The radius is declared on BOTH boxes on purpose. The card
                // itself is `sidebar-inner`; this outer box only positions and
                // transforms it — but `className` from the consumer lands
                // HERE, and a consumer that paints a background on it (the
                // project sidebar passed `bg-sidebar`) fills a square behind a
                // round card, which shows as four corner tabs sticking out
                // past the arc. Matching the radius clips that paint to the
                // same shape. No `overflow-hidden` — that would eat the card's
                // `shadow-xl`.
                flyout ? 'top-13 bottom-2 left-2 h-auto rounded-lg' : 'inset-y-0 left-0 h-svh',
                state === 'expanded'
                  ? 'translate-x-0'
                  : cn(
                      'transition-transform ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform motion-reduce:transition-none',
                      offscreen
                        ? cn(
                            // The extra 2rem parks the card's shadow off-screen too.
                            '-translate-x-[calc(100%+2rem)]',
                            undocking ? 'duration-[240ms]' : 'duration-[200ms]',
                          )
                        : 'translate-x-0 duration-[260ms]',
                      // ⌘B and Enter/Space collapse with no motion at all.
                      // Last in the `cn` on purpose: twMerge keeps the final
                      // `duration-*` in a class list, so this overrides
                      // whichever duration the branch above chose.
                      instantToggle && 'duration-0',
                    ),
              )
            : side === 'left'
              ? 'inset-y-0 left-0 h-svh group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]'
              : 'inset-y-0 right-0 h-svh group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]',
          // Adjust the padding for floating and inset variants.
          variant === 'floating' || variant === 'inset'
            ? 'p-00 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className={cn(
            'bg-sidebar group-data-[variant=floating]:border-sidebar-border flex h-full w-full flex-col group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:shadow-sm',
            // Gated on `flyout`, not on `peekable`: parked ↔ peeking swaps no
            // styles at all (the card slides in and out rigid), and the
            // undocking panel keeps the flush docked chrome so its exit is a
            // pure horizontal slide with no radius/shadow appearing mid-flight.
            // border-border, not border-sidebar-border: the sidebar token is
            // pure white in dark mode and reads as a glowing edge.
            //
            // No transition on the radius/shadow — same corollary as above,
            // they only ever change while the panel is off-screen.
            flyout && 'border-border overflow-hidden rounded-lg border shadow-xl',
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn(className)}
      onClick={(event) => {
        onClick?.(event);
        // Pass the event through: Enter/Space activation reports `detail === 0`
        // and collapses with no motion, a real click animates.
        toggleSidebar(event);
      }}
      {...props}
    >
      <PanelLeftIcon className="cn-rtl-flip" />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

/**
 * Invisible strip along the viewport's left edge that summons the collapsed
 * sidebar as a hover flyout. Renders nothing while the sidebar is docked
 * open or on mobile — the mobile sidebar is a sheet.
 */
function SidebarEdgePeek({ className, ...props }: React.ComponentProps<'div'>) {
  const { state, isMobile, peekEnter, peekLeave } = useSidebar();

  if (state !== 'collapsed' || isMobile) return null;

  return (
    <div
      aria-hidden
      data-slot="sidebar-edge-peek"
      onPointerEnter={peekEnter}
      onPointerLeave={peekLeave}
      className={cn('fixed inset-y-0 left-0 z-60 hidden w-2 md:block', className)}
      {...props}
    />
  );
}

/**
 * Drag handle on the panel's trailing edge — the sidebar's only resize
 * affordance.
 *
 * Resize ONLY. It used to toggle the sidebar on click, which put a second
 * collapse control on an edge that already reads as a resizer (it has shipped
 * a `col-resize` cursor the whole time) while the real one sits in the panel
 * header next to ⌘B. One edge, one job.
 *
 * Renders nothing while collapsed. There is nothing to resize, the strip is
 * translated off-screen with the panel anyway, and that edge belongs to
 * {@link SidebarEdgePeek} in the collapsed state.
 *
 * The drag writes `--sidebar-width` straight to the wrapper node and only
 * commits to React state on pointer-up: one render per drag instead of one per
 * pointermove. Width IS a layout property, so the content pane genuinely
 * reflows per frame here — that is the point of a resize, and it is the one
 * place in this file where per-frame layout is correct.
 */
function SidebarRail({ className, ...props }: React.ComponentProps<'div'>) {
  const { state, width, setWidth, previewWidth } = useSidebar();
  const [resizing, setResizing] = React.useState(false);
  const drag = React.useRef<{ startX: number; startWidth: number; next: number } | null>(null);
  const frame = React.useRef<number | null>(null);

  const stopDrag = React.useCallback(
    (commit: boolean) => {
      const active = drag.current;
      drag.current = null;
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      document.documentElement.removeAttribute('data-sidebar-resizing');
      setResizing(false);
      if (active) setWidth(commit ? active.next : active.startWidth);
    },
    [setWidth],
  );

  // Escape cancels a drag in flight and puts the width back. Bound to the
  // window, not the handle: the pointer is captured, so the handle is not
  // necessarily what has keyboard focus.
  React.useEffect(() => {
    if (!resizing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stopDrag(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [resizing, stopDrag]);

  // Unmounting mid-drag (collapse via ⌘B while dragging) must not leave the
  // global resize cursor latched on <html>.
  React.useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      document.documentElement.removeAttribute('data-sidebar-resizing');
    },
    [],
  );

  const nudge = (delta: number) => setWidth(width + delta);

  if (state === 'collapsed') return null;

  return (
    <div
      data-sidebar="rail"
      data-slot="sidebar-rail"
      data-resizing={resizing ? '' : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH_PX}
      aria-valuemax={SIDEBAR_MAX_WIDTH_PX}
      tabIndex={0}
      title="Drag to resize — double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width, next: width };
        document.documentElement.setAttribute('data-sidebar-resizing', '');
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active) return;
        active.next = clampSidebarWidth(
          active.startWidth + (event.clientX - active.startX),
          window.innerWidth,
        );
        // One paint per frame, whatever rate the pointer reports at.
        if (frame.current === null) {
          frame.current = requestAnimationFrame(() => {
            frame.current = null;
            if (drag.current) previewWidth(drag.current.next);
          });
        }
      }}
      onPointerUp={() => stopDrag(true)}
      onPointerCancel={() => stopDrag(false)}
      onDoubleClick={() => setWidth(SIDEBAR_WIDTH_PX)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? SIDEBAR_RESIZE_STEP_COARSE_PX : SIDEBAR_RESIZE_STEP_PX;
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          nudge(-step);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          nudge(step);
        } else if (event.key === 'Home') {
          event.preventDefault();
          setWidth(SIDEBAR_WIDTH_PX);
        }
      }}
      className={cn(
        'absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 cursor-col-resize touch-none outline-none select-none group-data-[side=left]:-right-4 group-data-[side=right]:left-0 sm:flex',
        // The hairline is a pseudo-element so the 16px hit area stays 16px
        // (well over the 8px a pointer needs) while the visible line stays 2px.
        // Opacity only — a width/position transition here would animate layout
        // on hover, on an element that sits over the content pane.
        'after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:opacity-0',
        'after:bg-sidebar-border after:transition-opacity after:duration-150 after:ease-out',
        'hover:after:opacity-100 focus-visible:after:opacity-100 data-[resizing]:after:opacity-100',
        // Tapered top and bottom so the line reads as a seam, not a border.
        'after:[clip-path:polygon(calc(50%-0.0625rem)_0%,calc(50%+0.0625rem)_0%,calc(50%+0.125rem)_50%,calc(50%+0.0625rem)_100%,calc(50%-0.0625rem)_100%,calc(50%-0.125rem)_50%)]',
        'after:[mask-image:linear-gradient(to_bottom,transparent,black_15%,black_85%,transparent)]',
        'motion-reduce:after:transition-none',
        className,
      )}
      {...props}
    />
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<'main'>) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        'bg-sidebar relative flex w-full flex-1 flex-col overflow-hidden',
        'md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2',
        className,
      )}
      {...props}
    />
  );
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn('bg-background h-8 w-full shadow-none', className)}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn('bg-sidebar-border mx-2 w-auto', className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
      {...props}
    />
  );
}

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';

  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        'text-sidebar-foreground/70 ring-sidebar-ring flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroupAction({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={cn(
        'text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-md p-0 outline-hidden transition-transform focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        // Increases the hit area of the button on mobile.
        'after:absolute after:-inset-2 md:after:hidden',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn('w-full text-sm', className)}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn('flex w-full min-w-0 flex-col gap-1', className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn('group/menu-item relative', className)}
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none transition-all cursor-pointer shadow-none group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-kortix-base focus-visible:ring-[0.6px] active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          'text-muted-foreground dark:hover:bg-sidebar-accent/50 hover:bg-sidebar-foreground/7 hover:text-sidebar-foreground',
        outline:
          'bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]',
        success:
          'bg-kortix-green/10 text-kortix-green hover:bg-kortix-green/20 hover:text-kortix-green active:bg-kortix-green/25 active:text-kortix-green data-[active=true]:bg-kortix-green/15 data-[active=true]:text-kortix-green data-[state=open]:hover:bg-kortix-green/20 data-[state=open]:hover:text-kortix-green dark:bg-kortix-green/15 dark:text-kortix-green dark:hover:bg-kortix-green/25 dark:hover:text-kortix-green dark:active:bg-kortix-green/30 dark:active:text-kortix-green dark:data-[active=true]:bg-kortix-green/20 dark:data-[active=true]:text-kortix-green dark:data-[state=open]:hover:bg-kortix-green/25 dark:data-[state=open]:hover:text-kortix-green',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        md: 'h-9 text-sm',
        lg: 'h-12 text-sm group-data-[collapsible=icon]:p-0!',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = 'default',
  size = 'default',
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipContent>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot.Root : 'button';
  const { isMobile, state } = useSidebar();

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  );

  if (!tooltip) {
    return button;
  }

  if (typeof tooltip === 'string') {
    tooltip = {
      children: tooltip,
    };
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== 'collapsed' || isMobile}
        {...tooltip}
      />
    </Tooltip>
  );
}

function SidebarMenuAction({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean;
  showOnHover?: boolean;
}) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        'text-sidebar-foreground ring-sidebar-ring peer-hover/menu-button:text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 outline-hidden transition-transform focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        // Increases the hit area of the button on mobile.
        'after:absolute after:-inset-2 md:after:hidden',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        showOnHover &&
          'peer-data-[active=true]/menu-button:text-sidebar-accent-foreground group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 md:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        'text-sidebar-foreground pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums select-none',
        'peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<'div'> & {
  showIcon?: boolean;
}) {
  // Random width between 50 to 90%.
  const width = React.useMemo(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`;
  }, []);

  return (
    <div
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn('flex h-8 items-center gap-2 rounded-md px-2', className)}
      {...props}
    >
      {showIcon && <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            '--skeleton-width': width,
          } as React.CSSProperties
        }
      />
    </div>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        'border-sidebar-border mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l px-2.5 py-0.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn('group/menu-sub-item relative', className)}
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  asChild = false,
  size = 'md',
  isActive = false,
  className,
  ...props
}: React.ComponentProps<'a'> & {
  asChild?: boolean;
  size?: 'sm' | 'md';
  isActive?: boolean;
}) {
  const Comp = asChild ? Slot.Root : 'a';

  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        'text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground [&>svg]:text-sidebar-accent-foreground flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 outline-hidden focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
        'data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground',
        size === 'sm' && 'text-xs',
        size === 'md' && 'text-sm',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarEdgePeek,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useOptionalSidebar,
  useSidebar,
};
