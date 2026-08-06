'use client';

import { useParams } from 'next/navigation';

import { CapabilityTabs } from '@/features/workspace/capabilities/shared/capability-tabs';

/**
 * Shared shell for /projects/[id]/{agent,connectors,skills}. The `(capabilities)`
 * route group keeps the segment out of the URL. The tab bar lives here — not
 * in each page — so it does not remount when switching tabs.
 *
 * **`h-svh`, and it is what pins the tab bar.** This box used to be
 * `min-h-0 flex-1`, which reads correct and is not: NOTHING above it has a
 * definite height. `<body>` is `min-height: 100dvh`, `sidebar-wrapper` is
 * `min-h-svh`, and `SidebarInset` plus the three project shells are all
 * `flex-1 … overflow-hidden` with no height of their own. `min-height` is a
 * floor, not a ceiling, so every one of those boxes sized to its content, the
 * `overflow-y-auto` in `CapabilityPageShell` never had a bound to scroll
 * within, and the WINDOW scrolled — taking the tab bar with it.
 *
 * One definite height anywhere in that chain fixes it, and this is the lowest
 * place it can go without touching shared primitives every authenticated route
 * renders through. `svh` (not `dvh`) because the small viewport assumes mobile
 * browser chrome is visible, so the bar cannot be pushed off under a toolbar
 * that reappears.
 *
 * `h-svh` is exact here rather than approximate: this is the first in-flow
 * child of `ProjectSheelLayout`, whose own ancestors add no vertical offset —
 * `SidebarInset`'s `m-2` applies only to `variant="inset"` and the sidebar
 * renders as `variant="sidebar"`, and the desktop title bar
 * (`.kx-desktop-chrome`) is `position: fixed`, so neither takes layout space.
 *
 * With the box bounded, the tab bar needs no `sticky` and no `fixed`. It is a
 * sibling ABOVE the only scrolling element on the page, so it structurally
 * cannot move. `sticky` would in fact have done nothing: `overflow: hidden`
 * makes an element a scroll container, sticky resolves against the nearest
 * ancestor scroll container, and there are five of those between the bar and
 * the viewport — it would have pinned to a box that never scrolls.
 */
export default function CapabilitiesLayout({ children }: { children: React.ReactNode }) {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <CapabilityTabs projectId={projectId} />
      {children}
    </div>
  );
}
