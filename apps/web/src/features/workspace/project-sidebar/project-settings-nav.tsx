'use client';

import { GearSixIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
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

/**
 * The two sidebar entries for the project's capability pages
 * (Connectors / Skills / Commands), which share one route and one permission
 * rule:
 *
 *  - ProjectCustomizeNavItem — top of the panel, under New session.
 *  - ProjectSettingsNavItem — bottom of the footer group, on the line the old
 *    Customize row held, and the one that carries the Mod+, keycap.
 *
 * Same destination by design. They differ only in placement, label, and icon,
 * so the gating and href logic lives in one hook rather than being copied.
 */

/**
 * The tab these entries land on, in preference order. Connectors is the default
 * landing tab; the fallbacks exist because the three tabs carry three separate
 * IAM leaves. A caller denied `project.connector.read` but allowed
 * `project.skill.read` used to still get a Skills row of their own — sending
 * them to a 403 Connectors page instead would be a regression, not a cleanup.
 */
const TAB_PREFERENCE: readonly { key: CapabilityTab['key']; action: string }[] = [
  { key: 'connectors', action: PROJECT_ACTIONS.PROJECT_CONNECTOR_READ },
  { key: 'skills', action: PROJECT_ACTIONS.PROJECT_SKILL_READ },
  { key: 'commands', action: PROJECT_ACTIONS.PROJECT_COMMAND_READ },
];

/**
 * First tab the caller may open, or null when every one of them is an explicit
 * deny. Optimistic while a probe loads — same rule as ProjectFilesNavItem: the
 * entry only disappears on a denial we actually received.
 *
 * The three probes are unconditional and fixed-order on purpose. Hooks cannot
 * be called from a loop that short-circuits.
 */
function useSettingsTab(projectId: string | undefined): CapabilityTab['key'] | null {
  const canConnectors = useProjectCan(projectId, TAB_PREFERENCE[0].action);
  const canSkills = useProjectCan(projectId, TAB_PREFERENCE[1].action);
  const canCommands = useProjectCan(projectId, TAB_PREFERENCE[2].action);

  const probes = [canConnectors, canSkills, canCommands];
  const hit = probes.findIndex((p) => p.allowed || p.isLoading);
  return hit === -1 ? null : TAB_PREFERENCE[hit].key;
}

/**
 * Mod+, — the shortcut the Customize row used to own. It now goes where the
 * Settings row goes, because a label and a keycap that disagree about their
 * destination are worse than no keycap. The Customize overlay is unchanged and
 * still opens from the command palette, project home, and /projects/:id/customize.
 */
export function useSettingsKeyboardShortcut() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const tab = useSettingsTab(projectId);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  useEffect(() => {
    if (!projectId || !tab) return;
    const handler = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key === ','
      ) {
        event.preventDefault();
        if (isMobile) setOpenMobile(false);
        router.push(capabilityTabHref(projectId, tab));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [projectId, tab, router, isMobile, setOpenMobile]);
}

/**
 * Customize — the top-of-panel entry, mounted directly under New session. Same
 * destination and same gate as ProjectSettingsNavItem; no keycap, because
 * Mod+, is printed on the Settings row and one shortcut should not be claimed
 * by two rows.
 *
 * Sliders, not a second gear: two identical gear rows in one panel read as a
 * duplicate, not as two ways in.
 */
export function ProjectCustomizeNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const tab = useSettingsTab(projectId);
  const isActive = !!pathname && activeCapabilityTab(pathname) !== null;

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!tab) return null;
  if (!projectId) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip="Customize"
        className="flex items-center gap-2 px-3 text-sm! font-medium [&_svg]:size-4!"
      >
        <Link href={capabilityTabHref(projectId, tab)} prefetch onClick={handleClick}>
          <span className="shrink-0">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="24"
              height="24"
              color="currentColor"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M15.365 9.72752C15.8998 10 16.5999 10 18 10C19.4001 10 20.1002 10 20.635 9.72752C21.1054 9.48783 21.4878 9.10538 21.7275 8.63498C22 8.1002 22 7.40013 22 6C22 4.59987 22 3.8998 21.7275 3.36502C21.4878 2.89462 21.1054 2.51217 20.635 2.27248C20.1002 2 19.4001 2 18 2C16.5999 2 15.8998 2 15.365 2.27248C14.8946 2.51217 14.5122 2.89462 14.2725 3.36502C14 3.8998 14 4.59987 14 6C14 7.40013 14 8.1002 14.2725 8.63498C14.5122 9.10538 14.8946 9.48783 15.365 9.72752Z"></path>
              <path d="M10 14V10C10 8.59987 10 7.8998 9.72752 7.36502C9.48783 6.89462 9.10538 6.51217 8.63498 6.27248C8.1002 6 7.40013 6 6 6C4.59987 6 3.8998 6 3.36502 6.27248C2.89462 6.51217 2.51217 6.89462 2.27248 7.36502C2 7.8998 2 8.59987 2 10V14H10Z"></path>
              <path d="M10 14H2V17C2 19.357 2 20.5355 2.73223 21.2678C3.46447 22 4.64298 22 7 22H10V14Z"></path>
              <path d="M14 14H10V22H14C15.4001 22 16.1002 22 16.635 21.7275C17.1054 21.4878 17.4878 21.1054 17.7275 20.635C18 20.1002 18 19.4001 18 18C18 16.5999 18 15.8998 17.7275 15.365C17.4878 14.8946 17.1054 14.5122 16.635 14.2725C16.1002 14 15.4001 14 14 14Z"></path>
            </svg>
          </span>
          Customize
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Settings — the footer entry for the project's capability pages
 * (Connectors / Skills / Commands). It replaces four rows of the bottom-anchored
 * footer group: the three capability entries, which were already tabs of one
 * layout, and the Customize row, whose line, gear, and Mod+, keycap it inherits.
 * It stays on that line — bottom of the permanent nav, under Files.
 *
 * A real `<Link prefetch>`, not `router.push` — same reason as
 * ProjectFilesNavItem: the button form cannot be prefetched, so every click
 * pays for the RSC payload and the route chunk cold.
 */
export function ProjectSettingsNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const tab = useSettingsTab(projectId);
  // useDevice() returns an OS string, never a boolean. `isMac ? … : …` on its
  // raw return is always truthy — that is how the old Customize row showed ⌘
  // to Windows users.
  const isMac = useDevice() === 'mac';
  const isActive = !!pathname && activeCapabilityTab(pathname) !== null;

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!tab) return null;
  if (!projectId) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip="Settings"
        className="group/settings-button flex items-center justify-between text-sm! font-medium [&_svg]:size-4!"
      >
        <Link href={capabilityTabHref(projectId, tab)} prefetch onClick={handleClick}>
          <span className="flex shrink-0 items-center gap-2">
            <GearSixIcon />
            Settings
          </span>
          <KbdGroup className="opacity-0 transition-opacity duration-50 group-hover/settings-button:opacity-100">
            <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>,</Kbd>
          </KbdGroup>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
