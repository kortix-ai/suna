'use client';

import { useState } from 'react';

import { useOptionalSidebar } from '@/components/ui/sidebar';
import { desktopShellPlatform, type DesktopShellPlatform } from '@/lib/desktop';

/**
 * Who is allowed to draw a "bring the sidebar back" control.
 *
 * The workspace sidebar is `collapsible="offcanvas"` — collapsed means gone, not
 * an icon rail — so every view that can be looked at with it hidden needs a way
 * back. Five of them grew their own copy of that control, each with its own
 * visibility rule, and the rules drifted apart:
 *
 *   - the session header gated on the desktop shell,
 *   - project home, the sessions inventory, the capability tabs and the
 *     Customize sections did not.
 *
 * On the desktop shell that is two openers for one panel, and the page-level
 * copies are absolutely positioned at `top-2 left-2` — which on macOS is
 * directly on top of the traffic lights. One rule, in one place, instead.
 */

/**
 * The desktop shell, read once. The user agent cannot change mid-session, so
 * re-deriving it per render only risks two components disagreeing.
 *
 * Lazy `useState` (not a module constant) because `navigator` does not exist
 * during SSR. Every caller lives under `WorkspaceShell`, which renders a blank
 * placeholder until client auth resolves, so the first client render matches
 * the server's and this cannot desync hydration.
 */
export function useDesktopShell(): DesktopShellPlatform | null {
  const [shell] = useState(() => desktopShellPlatform());
  return shell;
}

export interface PageSidebarOpenerInput {
  /** Is there a sidebar to open at all? */
  hasSidebar: boolean;
  /** Is this the Electron desktop shell (either platform)? */
  isDesktopShell: boolean;
  /** Viewport below the sidebar's mobile breakpoint — the panel is a Sheet. */
  isMobile: boolean;
  /** `SidebarProvider` state: 'expanded' | 'collapsed'. */
  state: string;
}

/**
 * Should THIS VIEW draw a sidebar opener?
 *
 * Pure, so the rule can be tested as a truth table instead of by mounting five
 * views under a sidebar + auth + query + i18n provider stack. The hook below
 * is the only thing that reads context.
 *
 * - No sidebar context → no.
 * - Desktop shell → no. `WorkspaceShellLayout` draws the single one, placed in
 *   the OS title-bar band clear of the window controls. A view-level copy
 *   would be a duplicate, and lands under the macOS traffic lights.
 * - Mobile → always. The panel is a Sheet with no docked affordance, and
 *   `state` there still reflects the DESKTOP cookie — so gating on it would
 *   strand the only way in whenever that cookie happened to say 'expanded'.
 * - Otherwise → only while the panel is undocked. Docked, the panel's own
 *   header carries collapse; two controls for one panel is one too many.
 */
export function shouldShowPageSidebarOpener({
  hasSidebar,
  isDesktopShell,
  isMobile,
  state,
}: PageSidebarOpenerInput): boolean {
  if (!hasSidebar || isDesktopShell) return false;
  return isMobile || state !== 'expanded';
}

/** {@link shouldShowPageSidebarOpener}, wired to the live contexts. */
export function useShowPageSidebarOpener(): boolean {
  const sidebar = useOptionalSidebar();
  const shell = useDesktopShell();
  return shouldShowPageSidebarOpener({
    hasSidebar: !!sidebar,
    isDesktopShell: shell !== null,
    isMobile: !!sidebar?.isMobile,
    state: sidebar?.state ?? 'collapsed',
  });
}

/**
 * "Pin", not "Open", while the panel is showing as a hover flyout — the click
 * docks what is already on screen, and calling that "Open" reads as a no-op.
 */
export function sidebarOpenerLabel(sidebar: {
  state: string;
  peek?: boolean;
}): string {
  if (sidebar.state === 'expanded') return 'Collapse sidebar';
  return sidebar.peek ? 'Pin sidebar' : 'Open sidebar';
}
