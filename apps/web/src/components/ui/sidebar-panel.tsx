'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  SIDEBAR_RESIZE_STEP_COARSE_PX,
  SIDEBAR_RESIZE_STEP_PX,
  SIDEBAR_UNDOCK_MS,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_ICON,
  SIDEBAR_WIDTH_MOBILE,
  useSidebar,
} from '@/components/ui/sidebar-context';
import {
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  SIDEBAR_WIDTH_PX,
  clampSidebarWidth,
  maxSidebarWidth,
} from '@/components/ui/sidebar-width';
import { cn } from '@/lib/utils';
import { SidebarToggle as PanelLeftIcon } from '@/features/icon/icons/sidebar-toggle';

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
          'bg-background text-sidebar-foreground flex h-full w-(--sidebar-width) flex-col',
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
          className="bg-background text-sidebar-foreground w-(--sidebar-width) p-0 [&>button]:hidden"
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
          // The content pane reclaims (or gives up) its 20rem in a single
          // reflow at t=0. That reflow is free to be visible only because it
          // happens UNDER this panel: at t=0 the panel still covers the exact
          // strip the pane just grew into, so the collapse reads as the panel
          // sliding off and uncovering content that was already there. On the
          // way back the strip it uncovers is `bg-background` on a `bg-background`
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
          // was not: the wrapper behind it is already `bg-background`, so the
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
                // project sidebar passed `bg-background`) fills a square behind a
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
            'bg-background group-data-[variant=floating]:border-sidebar-border flex h-full w-full flex-col group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:shadow-sm',
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
        'after:bg-kortix-base after:transition-opacity after:duration-100 after:ease-out',
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
        'bg-background relative flex w-full flex-1 flex-col overflow-hidden',
        'md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2',
        className,
      )}
      {...props}
    />
  );
}

export { Sidebar, SidebarTrigger, SidebarEdgePeek, SidebarRail, SidebarInset };
