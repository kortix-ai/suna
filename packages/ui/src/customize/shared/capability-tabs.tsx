'use client';

import { hubTarget } from '../../internal/stores/account-panel-store';
import { useLocalizedUiCatalog } from '../../i18n/ui-catalog/use-localized-ui-catalog';
import { useTranslations } from '../../i18n';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';

import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { HubLink } from '../../internal/account-hub/account-hub-location';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { useCapabilityAccess } from '../../internal/layout/project-settings-nav';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectPageCans } from '../../internal/lib/use-project-can';
import { cn } from '../../internal/lib/utils';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { receivedDenial } from './capability-access-gate';
import {
  CAPABILITY_TABS,
  PRIMARY_TABS,
  activeCapabilityTab,
  capabilityTabHref,
  type CapabilityTab,
} from '../../internal/lib/capability-tab-routes';

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
 *
 * It holds its place from the first frame. While the account id or the probe
 * is still in flight it renders as inert text of the same size, so the row
 * never reflows when they land; it leaves only on a denial the engine
 * returned. The probe rides the shared `PROJECT_PAGE_ACTIONS` batch, which the
 * sidebar has usually cached already.
 */
const MEMBERS_LINK_CLASS =
  'text-muted-foreground hover:text-foreground ml-auto flex w-fit flex-none items-center gap-1 px-1 py-3 text-sm font-medium whitespace-nowrap transition-colors';

function MembersLaunchLink({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { data } = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const canReadMembers = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_MEMBERS_READ];
  const accountId = data?.project?.account_id;
  if (receivedDenial(canReadMembers)) return null;

  const label = (
    <>
      {tI18nComplete.raw('text1044a4c056d0')}
      <ArrowUpRightIcon className="size-3 opacity-60" aria-hidden />
    </>
  );
  if (!accountId) return <span className={MEMBERS_LINK_CLASS}>{label}</span>;

  return (
    <HubLink
      to={hubTarget(accountId, {
        tab: 'access-projects',
        project: projectId,
      })}
      className={MEMBERS_LINK_CLASS}
    >
      {label}
    </HubLink>
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
 *
 * **Only the tabs the caller may open** (`capabilityAccess()`, the rule the
 * sidebar row and `CapabilityAccessGate` read). Until that answer arrives the
 * bar paints every tab with `invisible`: the row holds its height and nothing
 * flies in, and no tab the caller cannot open is ever clickable. It used to
 * paint every tab unconditionally, so a limited member saw five tabs that
 * opened onto "You don't have access" (KRTX-2144).
 */
/**
 * The hairline between Agents and everything an agent draws on (Skills
 * through Secrets). One `TabsList` still —
 * this is a `span`, not a second list, so the underline indicator and the
 * keyboard roving stay unified. It is `aria-hidden` because the grouping is
 * visual: a screen reader walks seven tabs either way.
 */
/**
 * Settings trails the row, on the right, after the Members link — one
 * `TabsList`, so the underline indicator, keyboard roving and `role="tablist"`
 * stay unified; only the visual position of this tab changes. It reads as
 * "how the project is configured", a different register from the build-the-
 * agent tabs to its left, and the gap says so without a second list.
 */
const TRAILING_TABS: readonly CapabilityTab['key'][] = ['config'];

/** Tabs that need a project flag: left out of the bar until access settles. */
const FLAG_GATED_TABS: readonly CapabilityTab['key'][] = ['files', 'reminders'];

function GroupSeam() {
  return <span aria-hidden className="bg-border mx-1 h-4 w-px shrink-0 self-center" />;
}

export function CapabilityTabs({ projectId }: { projectId: string }) {
  const pathname = useUiPathname();
  const activeKey = activeCapabilityTab(pathname);
  // This bar is the first in-flow child of the capabilities layout, which the
  // layout's own doc confirms adds no vertical offset — so on the desktop
  // shell it starts at y=0 and shares the band with the OS window controls.
  // Without the indent the first tab renders under the macOS traffic lights.
  const sidebar = useOptionalSidebar();
  const allTabs = useLocalizedUiCatalog(CAPABILITY_TABS);
  // Repo (key `files`) and Reminders are the flag-gated tabs: each exists only
  // once the project turns its flag on. `capabilityAccess()` applies the flags
  // and the leaves; before it settles the bar is invisible and both are left out.
  const access = useCapabilityAccess(projectId);
  const tabs = allTabs.filter((tab) =>
    access.settled ? access.tabs.includes(tab.key) : !FLAG_GATED_TABS.includes(tab.key),
  );

  const leading = tabs.filter((tab) => !TRAILING_TABS.includes(tab.key));
  const primary = leading.filter((tab) => PRIMARY_TABS.includes(tab.key));
  const library = leading.filter((tab) => !PRIMARY_TABS.includes(tab.key));
  const trailing = tabs.filter((tab) => TRAILING_TABS.includes(tab.key));
  const renderTab = (tab: CapabilityTab) => (
    <TabsTrigger key={tab.key} value={tab.key} asChild className="w-fit flex-none px-1 py-3">
      <Link href={capabilityTabHref(projectId, tab.key)} prefetch={true}>
        {tab.label}
      </Link>
    </TabsTrigger>
  );

  return (
    <div
      className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <FadedScrollArea
        orientation="horizontal"
        fadeColor="from-background"
        rootClassName="min-w-0 flex-1"
      >
        <Tabs value={activeKey ?? ''} className="w-max min-w-full">
          <TabsList
            type="underline"
            underlineSize="md"
            size="lg"
            className={cn(
              'kx-titlebar-tabs h-auto w-full justify-start gap-5 border-b-0 px-2',
              !access.settled && 'invisible',
            )}
            aria-busy={!access.settled || undefined}
          >
            {primary.map(renderTab)}
            {primary.length > 0 && library.length > 0 ? <GroupSeam /> : null}
            {library.map(renderTab)}
            <MembersLaunchLink projectId={projectId} />
            {trailing.map(renderTab)}
          </TabsList>
        </Tabs>
      </FadedScrollArea>
    </div>
  );
}
