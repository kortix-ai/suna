'use client';

import { ArrowUpRightIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';

import { MONITORING_TABS, activeMonitoringTab, monitoringTabHref } from './monitoring-tab-routes';

/**
 * The Monitoring tab bar — a clone of the Customize bar
 * (`shared/capability-tabs.tsx`): one underline `TabsList`, each trigger a
 * real `next/link`, mounted in the route-group layout so it never remounts
 * when switching tabs. No title text, like Customize: the tabs are the title.
 *
 * No permission probes here. Customize gates its bar on
 * `project.customize.read` because that surface is manager-tier; Monitoring
 * is for everyone who can run a session, and the pages below gate themselves
 * on the `monitoring` flag.
 *
 * Docs trails the row the way `MembersLaunchLink` does on Customize — a
 * plain styled `Link` outside the `Tabs` machinery, since it navigates away.
 */
export function MonitoringTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const activeKey = activeMonitoringTab(pathname);
  const sidebar = useOptionalSidebar();

  return (
    <div
      className="kx-titlebar-row relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <Tabs value={activeKey ?? ''} className="min-w-0 flex-1">
        <TabsList
          type="underline"
          underlineSize="md"
          size="lg"
          className="h-auto w-full justify-start gap-5 border-b-0 px-2"
        >
          {MONITORING_TABS.map((tab) => (
            <TabsTrigger
              key={tab.key}
              value={tab.key}
              asChild
              className="w-fit flex-none px-1 py-3"
            >
              <Link href={monitoringTabHref(projectId, tab.key)} prefetch={true}>
                {tab.label}
              </Link>
            </TabsTrigger>
          ))}
          <Link
            href="/docs/feature-flags/monitoring"
            target="_blank"
            rel="noopener noreferrer"
            prefetch={false}
            className="text-muted-foreground hover:text-foreground ml-auto flex w-fit flex-none items-center gap-1 px-1 py-3 text-sm font-medium whitespace-nowrap transition-colors"
          >
            Docs
            <ArrowUpRightIcon className="size-3 opacity-60" aria-hidden />
          </Link>
        </TabsList>
      </Tabs>
    </div>
  );
}
