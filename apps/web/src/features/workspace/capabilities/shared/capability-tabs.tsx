'use client';

import { ArrowUpRightIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { TAB_PREFERENCE } from '@/features/workspace/project-sidebar/project-settings-nav';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan, useProjectCans } from '@/lib/use-project-can';
import { getProjectDetail, type FeatureFlagKey } from '@kortix/sdk';
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import {
  CAPABILITY_TABS,
  activeCapabilityTab,
  capabilityTabHref,
  type CapabilityTab,
} from './capability-tab-routes';

/**
 * Every leaf this bar probes, in one batched request: the surface gate
 * (`project.customize.read`) plus each tab's own read leaf, taken from
 * `TAB_PREFERENCE` so the bar and the sidebar's Customize row can never
 * disagree about which action a tab costs.
 *
 * Module-level and frozen — `useProjectCans` keys its query on the action
 * list, so a fresh array per render would refetch forever.
 */
export const CAPABILITY_TAB_GATE_ACTIONS: readonly string[] = [
  ...new Set([PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ, ...TAB_PREFERENCE.map((t) => t.action)]),
];

/**
 * The per-project feature flags the tab list reads, resolved once.
 *
 * ENUMERATED, never derived by looping `CAPABILITY_TABS`. `useFeatureFlag` is a
 * hook, so a loop would make the number of hook calls depend on how many tabs
 * carry a `flag:` — React's rule of hooks forbids exactly that. When you add a
 * `flag:` to a tab, add its line here by hand.
 *
 * Both consumers of {@link visibleCapabilityTabs} that run in a component call
 * this: the bar below and the Customize index page. The `useFeatureFlag` cache
 * is shared, so the second caller costs no request.
 */
export function useCapabilityTabFlags(projectId: string): Partial<Record<FeatureFlagKey, boolean>> {
  const subprojects = useFeatureFlag(projectId, 'subprojects');
  return { subprojects: subprojects.enabled };
}

/**
 * Which tabs to draw for this caller.
 *
 * Three gates, the first two shared with the sidebar's Customize row because
 * this bar IS that row's destination:
 *
 *  1. `project.customize.read` — the whole Customize surface. It moved out of
 *     the member floor role in #6522 (`apps/api/src/iam/role-perms.ts`), so a
 *     plain project member gets NO tabs here. They had none of the entry
 *     points either, but a direct URL still renders this layout, and a bar of
 *     seven tabs that every one of them 403s on is exactly the "shown but not
 *     openable" surface this gate exists to remove.
 *  2. Each tab's own read leaf — a custom role can hold the surface and still
 *     have one capability deactivated.
 *  3. The tab's `flag`, when it declares one — whether the project has that
 *     surface at all.
 *
 * Gates 1 and 2 are OPTIMISTIC while a probe is in flight: a tab disappears
 * only on a denial we actually received, so a slow `/effective` never blanks
 * the bar for a manager mid-navigation. Gate 3 is the opposite, FAIL-CLOSED,
 * and the asymmetry is deliberate. An unresolved IAM probe is the common case
 * on every navigation and the tab is almost always allowed; an unresolved flag
 * is the rare case and the surface is almost always off (`platformDefault:
 * () => false` for every gated flag). Guessing "on" there flashes a tab whose
 * route answers `403 feature_disabled`.
 *
 * `flags` is REQUIRED, not optional with an all-on default, for the same
 * reason: a caller that forgets to pass it must lose the gated tabs, not gain
 * them.
 */
export function visibleCapabilityTabs(
  caps: Record<string, { allowed: boolean }>,
  flags: Partial<Record<FeatureFlagKey, boolean>>,
): readonly CapabilityTab[] {
  if (caps[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ]?.allowed === false) return [];
  return CAPABILITY_TABS.filter((tab) => {
    if (tab.flag && flags[tab.flag] !== true) return false;
    const pref = TAB_PREFERENCE.find((t) => t.key === tab.key);
    return pref ? caps[pref.action]?.allowed !== false : true;
  });
}

/**
 * "Members" — the tab-shaped row-item that launches the account-level Access
 * hub for this project, rather than a real capability page. It is NOT a
 * `CapabilityTab`: `capabilityTabHref`/`activeCapabilityTab` are shape-
 * sensitive to "every capability tab is a real page at /projects/<id>/<key>",
 * and this row is not one — clicking it navigates away entirely. So it's a
 * plain styled `Link` rendered as a `TabsList` sibling, matching a
 * `TabsTrigger`'s exact classes for visual parity, but living outside the
 * `Tabs`/`TabsTrigger` roving-tabindex/active-state machinery: it never lights
 * up as "current" (you're never actually on it), and Radix never needs to
 * reason about it as a tab panel.
 *
 * Needs the project's account_id, which this bar doesn't otherwise fetch —
 * `qk.project.detail(projectId)` is the same query key the page shell above
 * already populates, so this is a cache hit, not a second request.
 *
 * Gated on `project.members.read`, NOT `project.members.manage`: the hub's
 * project panel renders read-only for anyone who can read the member list and
 * probes `members.manage` itself for every write control it offers
 * (`components/iam/access-projects-tab.tsx`). Gating this launcher on manage
 * would hide a page a member can legitimately open.
 */
function MembersLaunchLink({ projectId }: { projectId: string }) {
  const { data } = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const canReadMembers = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_READ);
  const accountId = data?.project?.account_id;
  if (canReadMembers.allowed === false) return null;
  if (!accountId) return null;

  return (
    <Link
      /* `from=customize` is what earns the project panel a "Back to Customize"
         breadcrumb instead of the hub's own "All projects". This link is the
         ONLY way that marker gets set, so the panel can rely on there being a
         Customize entry in history to go back to. */
      href={`/accounts/${accountId}?tab=access-projects&project=${projectId}&from=customize`}
      /* `prefetch={false}` disabled every prefetch path, not just the viewport
         one: `next/dist/client/app-dir/link.js:108` derives `prefetchEnabled`
         from it, and both `onMouseEnter` and `onTouchStart` return early when
         it is off. The segment cache was therefore empty at click time and the
         click ran the RSC fetch cold — the fetch that degrades into a full
         document load on an auth bounce, a build-id skew, or a network blip. */
      prefetch
      className="text-muted-foreground hover:text-foreground ml-auto flex w-fit flex-none items-center gap-1 px-1 py-3 text-sm font-medium whitespace-nowrap transition-colors"
    >
      Members
      <ArrowUpRightIcon className="size-3 opacity-60" aria-hidden />
    </Link>
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
 * Settings trails the row, on the right — one `TabsList`, so the underline
 * indicator, keyboard roving, and `role="tablist"` semantics stay unified;
 * only the visual position of this tab changes. It reads as "how it's
 * configured", a different register from the build-the-agent tabs to its
 * left, and the gap says so without a second list or a divider. `ml-auto`
 * now lives on `MembersLaunchLink` (the first trailing element in DOM order,
 * rendered just before this array's tabs) — Settings trails it with no
 * further margin of its own.
 */
const TRAILING_TABS: readonly CapabilityTab['key'][] = ['config'];

export function CapabilityTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const activeKey = activeCapabilityTab(pathname);
  // This bar is the first in-flow child of the capabilities layout, which the
  // layout's own doc confirms adds no vertical offset — so on the desktop
  // shell it starts at y=0 and shares the band with the OS window controls.
  // Without the indent the first tab renders under the macOS traffic lights.
  const sidebar = useOptionalSidebar();
  const caps = useProjectCans(projectId, CAPABILITY_TAB_GATE_ACTIONS);
  const flags = useCapabilityTabFlags(projectId);
  const tabs = visibleCapabilityTabs(caps, flags);

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
          {tabs
            .filter((tab) => !TRAILING_TABS.includes(tab.key))
            .map((tab) => (
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
          <MembersLaunchLink projectId={projectId} />
          {tabs
            .filter((tab) => TRAILING_TABS.includes(tab.key))
            .map((tab) => (
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
    </div>
  );
}
