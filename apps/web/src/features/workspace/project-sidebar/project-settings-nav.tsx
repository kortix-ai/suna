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
import { useCustomizeStore } from '@/stores/customize-store';

/**
 * The two project-configuration entries in the sidebar. They are different
 * surfaces, and which one is which does not follow from the labels:
 *
 *  - ProjectCustomizeNavItem — top of the panel, under New session. Navigates
 *    to the capability pages (Connectors / Skills / Commands). Gated, because
 *    those pages can 403.
 *  - ProjectSettingsNavItem — bottom of the footer group, on the line the old
 *    Customize row held. Opens the Customize overlay and carries the Mod+,
 *    keycap. Ungated.
 */

/**
 * The tab the Customize row lands on, in preference order. Connectors is the
 * default landing tab; the fallbacks exist because the three tabs carry three
 * separate IAM leaves. A caller denied `project.connector.read` but allowed
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
function useCapabilityTab(projectId: string | undefined): CapabilityTab['key'] | null {
  const canConnectors = useProjectCan(projectId, TAB_PREFERENCE[0].action);
  const canSkills = useProjectCan(projectId, TAB_PREFERENCE[1].action);
  const canCommands = useProjectCan(projectId, TAB_PREFERENCE[2].action);

  const probes = [canConnectors, canSkills, canCommands];
  const hit = probes.findIndex((p) => p.allowed || p.isLoading);
  return hit === -1 ? null : TAB_PREFERENCE[hit].key;
}

/**
 * Mod+, — printed on the Settings row, so it does what that row does: open the
 * Customize overlay. A keycap that opens something other than the row it sits
 * on is worse than no keycap.
 */
export function useSettingsKeyboardShortcut() {
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
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
        openCustomize();
        if (isMobile) setOpenMobile(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openCustomize, isMobile, setOpenMobile]);
}

/**
 * Customize — the top-of-panel entry, mounted directly under New session. It
 * navigates to the project's capability pages (Connectors / Skills / Commands),
 * landing on Connectors by default.
 *
 * Gated on the three capability leaves via useCapabilityTab(): those pages 403
 * per-leaf, so a caller who may read none of them gets no row rather than a
 * dead one.
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
        className="flex items-center gap-2 px-3 text-sm! font-medium [&_svg]:size-4!"
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
              <path d="M15.365 9.72752C15.8998 10 16.5999 10 18 10C19.4001 10 20.1002 10 20.635 9.72752C21.1054 9.48783 21.4878 9.10538 21.7275 8.63498C22 8.1002 22 7.40013 22 6C22 4.59987 22 3.8998 21.7275 3.36502C21.4878 2.89462 21.1054 2.51217 20.635 2.27248C20.1002 2 19.4001 2 18 2C16.5999 2 15.8998 2 15.365 2.27248C14.8946 2.51217 14.5122 2.89462 14.2725 3.36502C14 3.8998 14 4.59987 14 6C14 7.40013 14 8.1002 14.2725 8.63498C14.5122 9.10538 14.8946 9.48783 15.365 9.72752Z" />
              <path d="M10 14V10C10 8.59987 10 7.8998 9.72752 7.36502C9.48783 6.89462 9.10538 6.51217 8.63498 6.27248C8.1002 6 7.40013 6 6 6C4.59987 6 3.8998 6 3.36502 6.27248C2.89462 6.51217 2.51217 6.89462 2.27248 7.36502C2 7.8998 2 8.59987 2 10V14H10Z" />
              <path d="M10 14H2V17C2 19.357 2 20.5355 2.73223 21.2678C3.46447 22 4.64298 22 7 22H10V14Z" />
              <path d="M14 14H10V22H14C15.4001 22 16.1002 22 16.635 21.7275C17.1054 21.4878 17.4878 21.1054 17.7275 20.635C18 20.1002 18 19.4001 18 18C18 16.5999 18 15.8998 17.7275 15.365C17.4878 14.8946 17.1054 14.5122 16.635 14.2725C16.1002 14 15.4001 14 14 14Z" />
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
 * Opens the Customize overlay, which is not a route: it floats over whatever
 * project page is active so you keep your place (see customize-store). That
 * rules out a `<Link prefetch>` — there is no href to prefetch — and it is why
 * active state reads the store's `open` flag rather than the pathname.
 *
 * Ungated on purpose. The Customize row gates on the three capability leaves
 * because that is where it navigates; the overlay also holds Agents, LLM
 * providers, and Members, so gating it on connector/skill/command read would
 * hide it from a caller who can still use most of what is inside.
 */
export function ProjectSettingsNavItem() {
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const isActive = useCustomizeStore((s) => s.open);
  // useDevice() returns an OS string, never a boolean. `isMac ? … : …` on its
  // raw return is always truthy — that is how the old Customize row showed ⌘
  // to Windows users.
  const isMac = useDevice() === 'mac';

  const handleClick = useCallback(() => {
    openCustomize();
    if (isMobile) setOpenMobile(false);
  }, [openCustomize, isMobile, setOpenMobile]);

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
