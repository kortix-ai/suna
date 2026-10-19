'use client';

import { useOptionalSidebar } from '../../../../components/ui/sidebar';
import { SidebarToggle } from './sidebar-toggle';

/**
 * The header of a standalone project page (Files, Apps):
 * the sidebar toggle, then the page title as the page's `<h1>`. It uses the
 * same title-bar classes as the Customize tab bar (`CapabilityTabs`), so it
 * has the same height and clears the desktop window controls the same way.
 * A page has one view, so the title is plain text, not a one-tab underline
 * bar. `children` sit at the trailing edge (page actions, a docs link).
 *
 * The e2e journey `18-apps-ui` finds the page by the
 * `<h1>`.
 */
export function ProjectPageHeader({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  const sidebar = useOptionalSidebar();
  return (
    <div
      className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <div className="kx-titlebar-tabs flex h-10 min-w-0 flex-1 items-center px-3">
        <h1 className="text-foreground truncate text-sm font-medium">{title}</h1>
      </div>
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
    </div>
  );
}
