'use client';

import * as React from 'react';

const SIDEBAR_COOKIE_NAME = 'sidebar_state';
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = '20rem';
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

export {
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_COOKIE_NAME,
  SIDEBAR_KEYBOARD_SHORTCUT,
  SIDEBAR_RESIZE_STEP_COARSE_PX,
  SIDEBAR_RESIZE_STEP_PX,
  SIDEBAR_UNDOCK_MS,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_ICON,
  SIDEBAR_WIDTH_MOBILE,
  resolveInstant,
  useOptionalSidebar,
  useSidebar,
};

export type { SidebarContextProps };
