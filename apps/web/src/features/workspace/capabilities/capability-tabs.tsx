'use client';

import { SidebarSimpleIcon as PanelLeft } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

import { CAPABILITY_TABS, activeCapabilityTab, capabilityTabHref } from './tabs';

/**
 * Absolute top-left opener — same rules as project-home / session header /
 * sessions inventory. Always on mobile (sheet has no docked affordance);
 * desktop only while the panel is undocked — ProjectSidebar already carries
 * collapse when expanded.
 */
function CapabilitySidebarToggle() {
  const sidebar = useOptionalSidebar();
  if (!sidebar) return null;
  if (!sidebar.isMobile && sidebar.state === 'expanded') return null;

  const label =
    sidebar.state === 'expanded'
      ? 'Collapse sidebar'
      : sidebar.peek
        ? 'Pin sidebar'
        : 'Open sidebar';

  return (
    <Hint label={label} side="bottom">
      <Button
        type="button"
        aria-label={label}
        variant="ghost"
        size="icon"
        onClick={sidebar.toggleSidebar}
        onPointerEnter={sidebar.state === 'collapsed' ? sidebar.peekEnter : undefined}
        onPointerLeave={sidebar.state === 'collapsed' ? sidebar.peekLeave : undefined}
        className="hover:bg-sidebar-accent hover:text-sidebar-foreground absolute top-1/2 left-2 z-20 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
      >
        <PanelLeft className="cn-rtl-flip size-4" />
      </Button>
    </Hint>
  );
}

/**
 * The shared tab bar for /projects/[id]/{connectors,skills,commands}. Lives in
 * the `(capabilities)` route group layout so it does not remount when
 * switching tabs. Each trigger wraps a real `next/link` via `asChild` — the
 * tabs are links (middle-click, cmd-click, and prefetch all work), not a
 * client-side tab switch.
 *
 * `shrink-0` is what keeps it pinned at full height. The layout is a bounded
 * `h-svh` column whose other child is `flex-1`, so this bar is the one item
 * flex would otherwise compress to make room — and a tab bar that loses a few
 * pixels per overflowing page is the kind of drift nobody attributes to the
 * right cause. It is a fixed band; say so.
 */
export function CapabilityTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const activeKey = activeCapabilityTab(pathname);
  const sidebar = useOptionalSidebar();
  const showSidebarToggle = sidebar != null && (sidebar.isMobile || sidebar.state !== 'expanded');

  return (
    <div className="relative shrink-0">
      <CapabilitySidebarToggle />
      <Tabs value={activeKey ?? ''}>
        <TabsList
          type="underline"
          underlineSize="md"
          size="lg"
          className={cn(
            'flex h-auto w-full items-center justify-start gap-5 px-4',
            // Clear the absolute toggle so the first tab does not sit under it.
            showSidebarToggle && 'pl-12',
          )}
        >
          {CAPABILITY_TABS.map((tab) => (
            <TabsTrigger
              key={tab.key}
              value={tab.key}
              asChild
              className="w-fit flex-none px-1 py-3"
            >
              <Link href={capabilityTabHref(projectId, tab.key)}>{tab.label}</Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
