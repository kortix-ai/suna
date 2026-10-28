'use client';

import { useOptionalSidebar } from '../../primitives/sidebar';
import { SidebarToggle } from './sidebar-toggle';

/**
 * The header of a standalone project page (Files, Apps):
 * the sidebar toggle, then the page title as the page's `<h1>`. It uses the
 * same title-bar classes as the Customize tab bar (`CapabilityTabs`), so it
 * has the same height and clears the desktop window controls the same way.
 * A page has one view, so the title is plain text, not a one-tab underline
 * bar. `titleAccessory` sits right after the title (a docs link). `children`
 * sit at the trailing edge (page actions).
 *
 * The e2e journey `18-apps-ui` finds the page by the
 * `<h1>`.
 */
export function ProjectPageHeader({
  title,
  titleAccessory,
  children,
}: {
  title: string;
  titleAccessory?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const sidebar = useOptionalSidebar();
  return (
    <div
      className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <div className="kx-titlebar-tabs flex h-10 min-w-0 flex-1 items-center gap-1.5 px-3">
        <h1 className="text-foreground truncate text-sm font-medium">{title}</h1>
        {titleAccessory}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
    </div>
  );
}
