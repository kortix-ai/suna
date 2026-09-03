'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import {
  activeCapabilityTab,
  capabilityTabHref,
  type CapabilityTab,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useIsMobile } from '@/hooks/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectPageCans } from '@/lib/use-project-can';

/**
 * The one project-configuration entry in the sidebar:
 * ProjectCustomizeNavItem, top of the panel under New session, navigating to
 * the capability pages (Models / Connectors / Agents / Skills / Triggers /
 * Marketplace / Secrets / Settings). Gated, because those pages can 403.
 * Marketplace is additionally flag-gated and appears only when a project turns
 * `subprojects` on — see `CapabilityTab.flag`.
 *
 * The bottom-of-footer "Settings" row that used to sit beside it is gone
 * (Jay, 2026-08-17): it opened the same User Settings overlay a click on the
 * workspace switcher already opens, one level up — a second row to an
 * identical destination. The overlay itself, and its Mod+, keyboard
 * shortcut, are unchanged; only this row's `<SidebarMenuItem>` is gone. The
 * shortcut moved out of this file on 2026-09-02 — it now sits with the surface
 * it opens (`settings/settings-shortcut.ts`, mounted by `SettingsPanel`), so
 * it binds wherever the panel is mounted rather than wherever this sidebar is.
 * The keycap it advertises is printed on `workspace-switcher.tsx`'s "Settings"
 * row, which is the row that opens the same overlay.
 */

/**
 * The tab the Customize row lands on, in preference order. **This mirrors
 * `CAPABILITY_TABS` and a test asserts it does** — the row should land on the
 * first tab of the bar it navigates into, so reordering the bar cannot leave
 * this pointing at the second one.
 *
 * The fallbacks exist because each tab carries its own IAM leaf: a caller
 * denied `project.connector.read` but allowed `project.skill.read` still gets
 * a working row, rather than a link to a page that 403s.
 *
 * Commands is intentionally absent: its standalone capability page was removed,
 * so there is no `/projects/<id>/commands` route to land on. Commands stays
 * reachable through the Customize overlay (`/customize/commands` via the
 * `proj-commands` palette entry and the Settings row).
 */
export const TAB_PREFERENCE: readonly { key: CapabilityTab['key']; action: string }[] = [
  // Agents lead the bar (Marko, 2026-09-01): an agent is the object a person
  // is granted, so the row lands on the list of them. Skills — the other
  // thing you build — follows. Both keep the read leaves they always had.
  { key: 'agent', action: PROJECT_ACTIONS.PROJECT_AGENT_READ },
  { key: 'skills', action: PROJECT_ACTIONS.PROJECT_SKILL_READ },
  { key: 'connectors', action: PROJECT_ACTIONS.PROJECT_CONNECTOR_READ },
  // Triggers covers both schedules and webhooks — two views of one resource,
  // a project trigger — so it has one leaf. `project.trigger.read` is in
  // PROJECT_MEMBER_BASELINE (apps/api/src/iam/role-perms.ts), so every project
  // role that could open these panes in the Settings overlay still can here.
  { key: 'triggers', action: PROJECT_ACTIONS.PROJECT_TRIGGER_READ },
  // Marketplace reuses `project.read`, the SAME leaf Models above it carries,
  // because that is what the API gates the catalog read on
  // (`requireSubprojectReadScope` -> PROJECT_ACTIONS.PROJECT_READ in
  // `apps/api/src/projects/routes/subprojects.ts`). Sharing it has a second
  // effect: `useCapabilityTab` below walks THIS list and knows nothing about
  // feature flags, so a distinct leaf could make the Customize row land on
  // Marketplace for a caller whose `subprojects` flag is off — a row to a page
  // that answers 403. Models precedes it on the same leaf, so that branch is
  // unreachable. Keep them sharing the leaf, or teach `useCapabilityTab` the
  // flag.
  { key: 'marketplace', action: PROJECT_ACTIONS.PROJECT_READ },
  // Review — the inbox, on the bar since 2026-09-02 (it was a section of the
  // retired `/config` page). Same read leaf `CUSTOMIZE_SECTION_ACCESS.review`
  // gated the section on; the `review_center` flag is applied by the bar
  // (`visibleCapabilityTabs`), not by this permission list.
  { key: 'review', action: PROJECT_ACTIONS.PROJECT_REVIEW_READ },
  // Models and Secrets graduated out of the Settings overlay's sub-nav onto
  // their own top-level tabs. Their read leaves are carried over unchanged
  // from `lib/project-actions.ts`'s `CUSTOMIZE_SECTION_ACCESS` map
  // (`llm-management` -> project.read, `secrets` -> secret.read) — moving
  // where a section is reachable FROM never changed who can reach it.
  { key: 'models', action: PROJECT_ACTIONS.PROJECT_READ },
  // Channels is NOT a row here any more. It is a scope of the Connectors page
  // (`channelsHref`), and it always gated on `project.connector.read` — the
  // same leaf the Connectors row above already probes, so folding it in
  // removed a duplicate probe rather than a gate.
  { key: 'secrets', action: PROJECT_ACTIONS.PROJECT_SECRET_READ },
  // Settings (`/projects/<id>/config`) holds the project configuration that
  // did not earn its own top-level tab. It reuses `project.customize.write`,
  // the SAME leaf the row itself gates on above, rather than inventing a
  // narrower one: anyone who can see the Customize row at all can open this
  // tab, so a second, stricter probe here could only ever produce a row that
  // leads nowhere. Retired 2026-09-02, back 2026-09-03 (Marko).
  { key: 'config', action: PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE },
];

/**
 * First tab the caller may open, or null when every one of them is an explicit
 * deny. Optimistic while a probe loads — same rule as ProjectFilesNavItem: the
 * entry only disappears on a denial we actually received.
 *
 * The probes are unconditional and fixed-order on purpose. Hooks cannot
 * be called from a loop that short-circuits.
 */
function useCapabilityTab(projectId: string | undefined): CapabilityTab['key'] | null {
  // ONE request. These used to be seven `useProjectCan` singles, and each one
  // is its own `GET …/iam/members/:me/effective?action=…` plus a CORS
  // preflight — fourteen round trips on every project page open, for a
  // sidebar row. `useCans` sends the list to `effective:batch` and answers all
  // seven from one response; the order below is still the preference order.
  const results = useProjectPageCans(projectId);
  const hit = TAB_PREFERENCE.findIndex((tab) => {
    const probe = results[tab.action];
    return !!probe && (probe.allowed || probe.isLoading);
  });
  return hit === -1 ? null : TAB_PREFERENCE[hit].key;
}

/**
 * Customize — the top-of-panel entry, mounted directly under New session. It
 * navigates to the FIRST capability tab the caller may open — Agents, for
 * anyone who can read them — through `capabilityTabHref`. Customize is
 * agent-centric (Marko, 2026-09-01): the agent is the object a person is
 * granted, so the row lands on the list of agents, not on a chooser page
 * that introduces seven equal tabs. The former index at `/customize` still
 * resolves — it redirects here through the same `TAB_PREFERENCE` — so every
 * bookmark, palette entry and shortcut that names it keeps working.
 *
 * Gated TWICE, on two different questions:
 *
 *  1. Can this caller reach the Customize surface at all?
 *     `project.customize.read` — the one leaf that answers "may this person
 *     open Customize", and the surface gate every other Customize entry point
 *     now shares: this row, the project-home setup tiles
 *     (`project-layout/project-home.tsx`), and the capability tab bar itself
 *     (`capabilities/shared/capability-tabs.tsx`).
 *
 *     It is `.read`, not `.write`: `.write` conflated "may see the surface"
 *     with "may change things on it", so a role that can browse a tab was
 *     denied the only discovery path to it. `.write` still gates every
 *     individual mutation on every page beneath this row (each tab, and the
 *     Settings/config tab's own sections, already probe their own write leaf).
 *
 *     It lives in `MANAGER_EXTRAS`, not `PROJECT_MEMBER_BASELINE`
 *     (`apps/api/src/iam/role-perms.ts`, moved there by #6522 along with
 *     connector/skill/file/secret read): a plain project `member` is a read +
 *     RUN role and reaches NO part of Customize by default, so this row is
 *     absent for them — which is the whole point, since every page under it
 *     403s on load.
 *  2. Does at least one tab exist for them to land on once there?
 *     `useCapabilityTab()` still probes each tab's own read leaf — a caller
 *     denied every single one gets no row at all, rather than a link to an
 *     index with nothing on it.
 *
 * A real `<Link prefetch>`, not `router.push` — same reason as
 * ProjectFilesNavItem: the button form cannot be prefetched, so every click
 * pays for the RSC payload and the route chunk cold. It is hover-gated
 * (`HoverPrefetchLink`) because prefetching on mount charged every session open
 * a full dynamic render of /customize, whether or not anyone went there.
 *
 * Sliders, not a second gear: two identical gear rows in one panel read as a
 * duplicate, not as two ways in. No keycap either — Mod+, is printed on the
 * Settings row, and one shortcut advertised on two rows is a lie on one of them.
 */
export function ProjectCustomizeNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const caps = useProjectPageCans(projectId);
  const canCustomize = caps[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ];
  const tab = useCapabilityTab(projectId);
  // Active on the legacy index (`/customize`, for the instant before it
  // redirects) AND on any capability tab — the row stays lit while browsing
  // Connectors or one agent's page, not just on the landing tab.
  const isActive =
    !!pathname &&
    (pathname === `/projects/${projectId}/customize` || activeCapabilityTab(pathname) !== null);

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  // Hide only on an explicit deny we actually received — same optimistic
  // rule as every other probe-gated row, so a slow permission check never
  // flashes the row away for someone who does have access.
  if (canCustomize.allowed === false) return null;
  if (!tab) return null;
  // No project id means no valid href, so there is nothing to render.
  if (!projectId) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip="Customize"
        className="group/menu-button text-sidebar-foreground relative"
      >
        <HoverPrefetchLink href={capabilityTabHref(projectId, tab)} prefetch onClick={handleClick}>
          <span className="shrink-0">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="24"
              height="24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15.37 9.73C15.9 10 16.6 10 18 10C19.4 10 20.1 10 20.64 9.73C21.11 9.49 21.49 9.11 21.73 8.63C22 8.1 22 7.4 22 6C22 4.6 22 3.9 21.73 3.37C21.49 2.89 21.11 2.51 20.64 2.27C20.1 2 19.4 2 18 2C16.6 2 15.9 2 15.37 2.27C14.89 2.51 14.51 2.89 14.27 3.37C14 3.9 14 4.6 14 6C14 7.4 14 8.1 14.27 8.63C14.51 9.11 14.89 9.49 15.37 9.73Z" />
              <path d="M10 14V10C10 8.6 10 7.9 9.73 7.37C9.49 6.89 9.11 6.51 8.63 6.27C8.1 6 7.4 6 6 6C4.6 6 3.9 6 3.37 6.27C2.89 6.51 2.51 6.89 2.27 7.37C2 7.9 2 8.6 2 10V14H10Z" />
              <path d="M10 14H2V17C2 19.36 2 20.54 2.73 21.27C3.46 22 4.64 22 7 22H10V14Z" />
              <path d="M14 14H10V22H14C15.4 22 16.1 22 16.64 21.73C17.11 21.49 17.49 21.11 17.73 20.64C18 20.1 18 19.4 18 18C18 16.6 18 15.9 17.73 15.37C17.49 14.89 17.11 14.51 16.64 14.27C16.1 14 15.4 14 14 14Z" />
            </svg>
          </span>
          Customize
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
