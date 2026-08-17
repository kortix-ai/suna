'use client';

import { GearSixIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useCallback, useEffect } from 'react';

import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import {
  activeCapabilityTab,
  capabilityTabHref,
  type CapabilityTab,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useDevice } from '@/hooks/use-device';
import { useIsMobile } from '@/hooks/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

/**
 * The two project-configuration entries in the sidebar. They are different
 * surfaces, and which one is which does not follow from the labels:
 *
 *  - ProjectCustomizeNavItem — top of the panel, under New session. Navigates
 *    to the capability pages (Connectors / Agents / Skills). Gated, because
 *    those pages can 403.
 *  - ProjectSettingsNavItem — bottom of the footer group, on the line the old
 *    Customize row held. Opens the Customize overlay and carries the Mod+,
 *    keycap. Ungated.
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
const TAB_PREFERENCE: readonly { key: CapabilityTab['key']; action: string }[] = [
  { key: 'connectors', action: PROJECT_ACTIONS.PROJECT_CONNECTOR_READ },
  { key: 'agent', action: PROJECT_ACTIONS.PROJECT_AGENT_READ },
  { key: 'skills', action: PROJECT_ACTIONS.PROJECT_SKILL_READ },
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
  const canConnectors = useProjectCan(projectId, TAB_PREFERENCE[0].action);
  const canAgents = useProjectCan(projectId, TAB_PREFERENCE[1].action);
  const canSkills = useProjectCan(projectId, TAB_PREFERENCE[2].action);

  const probes = [canConnectors, canAgents, canSkills];
  const hit = probes.findIndex((p) => p.allowed || p.isLoading);
  return hit === -1 ? null : TAB_PREFERENCE[hit].key;
}

/**
 * Mod+, — printed on the Settings row, so it does what that row does: open the
 * Settings overlay. A keycap that opens something other than the row it sits
 * on is worse than no keycap.
 */
export function useSettingsKeyboardShortcut() {
  const openSettings = useSettingsPanelStore((s) => s.openSettings);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key === ','
      ) {
        event.preventDefault();
        openSettings();
        if (isMobile) setOpenMobile(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openSettings, isMobile, setOpenMobile]);
}

/**
 * Customize — the top-of-panel entry, mounted directly under New session. It
 * navigates to the project's capability pages (Connectors / Agents / Skills),
 * landing on the bar's first tab.
 *
 * Gated on the three capability leaves via useCapabilityTab(): those pages 403
 * per-leaf, so a caller who may read none gets no row rather than a dead one.
 *
 * A real `<Link prefetch>`, not `router.push` — same reason as
 * ProjectFilesNavItem: the button form cannot be prefetched, so every click
 * pays for the RSC payload and the route chunk cold.
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
  const tab = useCapabilityTab(projectId);
  const isActive = !!pathname && activeCapabilityTab(pathname) !== null;

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!tab) return null;
  // No project id means no valid href, so there is nothing to render.
  if (!projectId) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip="Customize"
        className="group/menu-button text-muted-foreground hover:text-sidebar-foreground flex items-center gap-2 px-3 text-sm! font-medium [&_svg]:size-4!"
      >
        <Link href={capabilityTabHref(projectId, tab)} prefetch onClick={handleClick}>
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
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Settings — the bottom-of-footer entry, on the line the old Customize row
 * held, and the one that keeps its gear and its Mod+, keycap.
 *
 * Opens the Settings overlay, which is not a route: it floats over whatever
 * project page is active so you keep your place (see settings-panel-store).
 * That rules out a `<Link prefetch>` — there is no href to prefetch — and it
 * is why active state reads the store's `open` flag rather than the pathname.
 *
 * Ungated on purpose. The Customize row gates on the two capability leaves
 * because that is where it navigates; the overlay also holds Agents, LLM
 * providers, and Members (and Commands, whose standalone page was removed),
 * so gating it on connector/skill read would hide it from a caller who can
 * still use most of what is inside.
 */
export function ProjectSettingsNavItem() {
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const openSettings = useSettingsPanelStore((s) => s.openSettings);
  const isActive = useSettingsPanelStore((s) => s.open);
  // useDevice() returns an OS string, never a boolean. `isMac ? … : …` on its
  // raw return is always truthy — that is how the old Customize row showed ⌘
  // to Windows users.
  const isMac = useDevice() === 'mac';

  const handleClick = useCallback(() => {
    openSettings();
    if (isMobile) setOpenMobile(false);
  }, [openSettings, isMobile, setOpenMobile]);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={handleClick}
        isActive={isActive}
        tooltip="Settings"
        className="group/settings-button flex items-center justify-between text-sm! font-medium [&_svg]:size-4!"
      >
        <span className="flex shrink-0 items-center gap-2">
          <GearSixIcon />
          Settings
        </span>
        <KbdGroup className="opacity-0 transition-opacity duration-50 group-hover/settings-button:opacity-100">
          <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>,</Kbd>
        </KbdGroup>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
