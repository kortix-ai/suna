'use client';

import Link from 'next/link';

import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';

/**
 * The header of a standalone project page (Review, Files, Reminders, Apps):
 * the Customize tab bar (`CapabilityTabs`) with one tab, the page itself.
 * Same title-bar classes, so it has the same height and clears the desktop
 * window controls the same way; same sidebar toggle; same underline tab.
 * `children` sit at the trailing edge (page actions, a docs link).
 *
 * The page's heading is the `<h1>` below, visually hidden: the tab is the
 * visible title, but a tab cannot carry it — `role="tab"` flattens its
 * children (ARIA "children presentational"), so a heading inside the link
 * would vanish from the accessibility tree. These pages had a real `<h1>`
 * before they moved onto this header (#8761), and screen-reader heading
 * navigation and the e2e journeys (`18-apps-ui`, `36-reminders-ui`) find the
 * page by it.
 */
export function ProjectPageHeader({
  title,
  href,
  children,
}: {
  title: string;
  href: string;
  children?: React.ReactNode;
}) {
  const sidebar = useOptionalSidebar();
  return (
    <div
      className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <h1 className="sr-only">{title}</h1>
      <Tabs value="page" className="min-w-0 flex-1">
        <TabsList
          type="underline"
          underlineSize="md"
          size="lg"
          className="kx-titlebar-tabs h-auto w-full justify-start gap-5 border-b-0 px-2"
        >
          <TabsTrigger value="page" asChild className="w-fit flex-none px-1 py-3">
            <Link href={href} prefetch={true}>
              {title}
            </Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
    </div>
  );
}
