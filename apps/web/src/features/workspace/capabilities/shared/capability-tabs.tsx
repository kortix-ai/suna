'use client';

import { SidebarSimpleIcon as PanelLeft } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  sidebarOpenerLabel,
  useShowPageSidebarOpener,
} from '@/features/workspace/project-layout/sidebar-opener';
import { TAB_PREFERENCE } from '@/features/workspace/project-sidebar/project-settings-nav';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';

import {
  CAPABILITY_TABS,
  activeCapabilityTab,
  capabilityTabHref,
  type CapabilityTab,
} from './capability-tab-routes';

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
 * Shared tab bar for
 * /projects/[id]/{agent,connectors,skills,schedules,webhooks}. Lives in the
 * `(capabilities)` route group layout so it does not remount when switching
 * tabs. Each trigger wraps a real `next/link` via `asChild`.
 *
 * One flex row, everything in flow: [sidebar toggle?] [tabs].
 * Absolute overlays and expanded hit areas are forbidden here — they steal
 * pointer events across the row.
 *
 * Global rules used to sit at the far right of this bar. It is connector
 * approval policy, not a project-wide setting, so it now lives at the far
 * right of the Connectors page's own Discovery/All/Connected row
 * (`connectors/connectors-page.tsx`). Nothing capability-wide belongs here —
 * this bar navigates, it does not act.
 *
 * `shrink-0` keeps the bar pinned at full height inside the layout's `h-svh`
 * column; the page body below is the flex-1 scroller.
 */
/**
 * Members and Settings trail the row, pushed to the far right with `ml-auto`
 * on Members (the first of the two) — one `TabsList`, so the underline
 * indicator, keyboard roving, and `role="tablist"` semantics stay unified;
 * only the visual position of these two changes. They read as "who's here /
 * how it's configured", a different register from the seven build-the-agent
 * tabs to their left, and the gap says so without a second list or a divider.
 */
const TRAILING_TABS: readonly CapabilityTab['key'][] = ['members', 'config'];

/** Stable across renders — `useProjectCans` keys its query on this list. */
const TAB_ACTIONS: readonly string[] = TAB_PREFERENCE.map((t) => t.action);

export function CapabilityTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const activeKey = activeCapabilityTab(pathname);
  // A tab whose destination the caller is denied is not rendered. Four of the
  // eight — Connectors, Agents, Skills, Secrets — assert leaves that are NOT in
  // PROJECT_MEMBER_BASELINE (apps/api/src/iam/role-perms.ts), and their pages
  // gate only their WRITE controls, so the list GET still fired and 403'd into
  // an error state. This bar was the last of four surfaces built on the same
  // TAB_PREFERENCE table still rendering it unfiltered — the Customize rail
  // (`project-settings-nav`), the Customize index (`customize-index-page`) and
  // the project-home setup pills all already drop denied entries.
  //
  // Explicit deny only (`allowed === false`), never `!allowed`: an in-flight
  // probe reports allowed:false, and a bar that empties on every cold load and
  // refills is worse than one that briefly offers a tab.
  const caps = useProjectCans(projectId, TAB_ACTIONS);
  const tabs = CAPABILITY_TABS.filter((tab) => {
    const pref = TAB_PREFERENCE.find((t) => t.key === tab.key);
    return pref ? caps[pref.action]?.allowed !== false : true;
  });
  // `ml-auto` pushes the trailing pair to the right. Anchor it on the first
  // trailing tab STILL PRESENT: hardcoding 'members' loses the spacer whenever
  // members is the denied one, and Settings would then sit flush against the
  // build-the-agent tabs instead of across the gap.
  const trailingAnchor = TRAILING_TABS.find((key) => tabs.some((t) => t.key === key));
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
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.key}
              value={tab.key}
              asChild
              className={cn('w-fit flex-none px-1 py-3', tab.key === trailingAnchor && 'ml-auto')}
            >
              <Link href={capabilityTabHref(projectId, tab.key)} prefetch={true}>
                {tab.label}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
