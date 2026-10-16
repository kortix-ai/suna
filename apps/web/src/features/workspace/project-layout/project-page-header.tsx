'use client';

import { useOptionalSidebar } from '@/components/ui/sidebar';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import Link from 'next/link';

/**
 * One section of a multi-view page's title bar. `active` follows the URL the
 * page was rendered for, so no bar-internal state is needed.
 */
export interface ProjectPageHeaderTab {
  key: string;
  label: string;
  href: string;
  active: boolean;
}

/**
 * The header of a standalone project page (Files, Reminders, Apps): the
 * sidebar toggle, then the page title as the page's `<h1>`. It uses the same
 * title-bar classes as the Customize tab bar (`CapabilityTabs`), so it has
 * the same height and clears the desktop window controls the same way.
 * `children` sit at the trailing edge (page actions, a docs link).
 *
 * A page may hold more than one view: pass `tabs` and the title becomes an
 * underline tab bar in the `CapabilityTabs` style, one trigger per view,
 * each a real link. A single entry falls back to the plain `h1` — a one-tab
 * underline bar reads as a title with pointless chrome. The e2e journeys
 * (`18-apps-ui`, `36-reminders-ui`) find the page by the `<h1>`.
 */
export function ProjectPageHeader({
  title,
  tabs,
  children,
}: {
  title: string;
  tabs?: ProjectPageHeaderTab[];
  children?: React.ReactNode;
}) {
  const sidebar = useOptionalSidebar();
  return (
    <div
      className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      {tabs && tabs.length > 1 ? (
        <div className="kx-titlebar-tabs flex h-10 min-w-0 flex-1 items-center px-3">
          <Tabs value={tabs.find((tab) => tab.active)?.key ?? ''} className="w-max">
            <TabsList
              type="underline"
              underlineSize="md"
              size="lg"
              className="h-auto justify-start gap-5 border-b-0 px-2"
            >
              {tabs.map((tab) => (
                <TabsTrigger key={tab.key} value={tab.key} asChild className="w-fit flex-none px-1 py-3">
                  <Link href={tab.href} prefetch={true}>
                    {tab.label}
                  </Link>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      ) : (
        <div className="kx-titlebar-tabs flex h-10 min-w-0 flex-1 items-center px-3">
          <h1 className="text-foreground truncate text-sm font-medium">{title}</h1>
        </div>
      )}
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
    </div>
  );
}
