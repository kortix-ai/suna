'use client';

import { SidebarSimpleIcon as PanelLeft, ShieldCheckIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { PoliciesPanel } from '@/components/projects/policies-panel';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  sidebarOpenerLabel,
  useShowPageSidebarOpener,
} from '@/features/workspace/project-layout/sidebar-opener';

import { CAPABILITY_TABS, activeCapabilityTab, capabilityTabHref } from './capability-tab-routes';

/**
 * Sidebar opener — same rules as project-home / session header / sessions
 * inventory. Always on mobile (sheet has no docked affordance); desktop only
 * while the panel is undocked — ProjectSidebar already carries collapse when
 * expanded.
 *
 * Sits in flow with the tabs. Do not absolute-position it over the tab row:
 * that is how hit targets collide.
 */
function CapabilitySidebarToggle() {
  const sidebar = useOptionalSidebar();
  // Shared gate — see sidebar-opener.ts. Must be called before the early
  // return, and it already covers the `!sidebar` case.
  const show = useShowPageSidebarOpener();
  if (!sidebar || !show) return null;

  const label = sidebarOpenerLabel(sidebar);

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
        className="hover:bg-sidebar-accent hover:text-sidebar-foreground shrink-0 cursor-pointer active:scale-[0.96]"
      >
        <PanelLeft className="cn-rtl-flip size-4" />
      </Button>
    </Hint>
  );
}

/**
 * Project-wide connector rules. Far-right of the shared tab bar so it stays
 * reachable from Connectors, Skills, and Commands.
 *
 * Opens as a Sheet, not a Modal: the panel is a long CRUD list that benefits
 * from a persistent side surface. No Hint — the button already shows its
 * label. No `before:-inset` hit expand — without `relative` that pseudo
 * stretches to the nearest positioned ancestor (this whole bar) and steals
 * clicks from the tab triggers.
 */
function GlobalRulesControl({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Global rules"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-foreground shrink-0 gap-1.5 active:scale-[0.96]"
      >
        <ShieldCheckIcon className="size-4" />
        <span className='hidden md:block'>Global rules</span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-xl md:max-w-2xl"
        >
          {/* `pr-12` clears the sheet's own close button, which is absolutely
              positioned at `top-4 right-4`. */}
          <SheetHeader className="border-border shrink-0 space-y-1 border-b px-5 py-4 pr-12 text-left">
            <SheetTitle className="text-base font-medium">Global rules</SheetTitle>
            <SheetDescription className="text-xs text-pretty">
              Approval rules that apply to every connector in this project.
            </SheetDescription>
          </SheetHeader>
          {/* The body is the only scroller, so the panel's save bar can stick
              to its bottom edge. */}
          <SheetBody className="min-h-0 gap-0 px-5 py-5">
            <PoliciesPanel projectId={projectId} />
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * Shared tab bar for /projects/[id]/{agent,connectors,skills}. Lives in
 * the `(capabilities)` route group layout so it does not remount when
 * switching tabs. Each trigger wraps a real `next/link` via `asChild`.
 *
 * One flex row, everything in flow: [sidebar toggle?] [tabs] [global rules].
 * Absolute overlays and expanded hit areas are forbidden here — they steal
 * pointer events across the row.
 *
 * `shrink-0` keeps the bar pinned at full height inside the layout's `h-svh`
 * column; the page body below is the flex-1 scroller.
 */
export function CapabilityTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const activeKey = activeCapabilityTab(pathname);
  // This bar is the first in-flow child of the capabilities layout, which the
  // layout's own doc confirms adds no vertical offset — so on the desktop
  // shell it starts at y=0 and shares the band with the OS window controls.
  // Without the indent the first tab renders under the macOS traffic lights.
  const sidebar = useOptionalSidebar();

  return (
    <div
      className="kx-titlebar-row relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <CapabilitySidebarToggle />
      <Tabs value={activeKey ?? ''} className="min-w-0 flex-1">
        <TabsList
          type="underline"
          underlineSize="md"
          size="lg"
          className="h-auto w-full justify-start gap-5 border-b-0 px-2"
        >
          {CAPABILITY_TABS.map((tab) => (
            <TabsTrigger
              key={tab.key}
              value={tab.key}
              asChild
              className="w-fit flex-none px-1 py-3"
            >
              <Link href={capabilityTabHref(projectId, tab.key)} prefetch={true}>
                {tab.label}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <GlobalRulesControl projectId={projectId} />
    </div>
  );
}
