'use client';

import { GearSixIcon } from '@phosphor-icons/react';
import { useCallback, useEffect } from 'react';

import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useDevice } from '@/hooks/use-device';
import { useIsMobile } from '@/hooks/utils';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

/**
 * The two project-configuration entries in the sidebar. They open the two
 * halves of the same shell (`settings/settings-panel.tsx`), split by
 * `TAB_SURFACE` in `settings/settings-tabs.ts`:
 *
 *  - ProjectCustomizeNavItem — top of the panel, under New session. Opens
 *    Customize: what the agent is and what it can do (Agents, Skills, Models,
 *    Connectors, Apps, Channels, Schedules, Webhooks, Secrets, Sandbox
 *    templates, Snapshots, Marketplace).
 *  - ProjectSettingsNavItem — bottom of the footer group. Opens Settings:
 *    administration (profile, members, billing, roles, audit, API keys), and
 *    carries the Mod+, keycap.
 *
 * Neither is gated. Each panel holds a dozen panes behind a dozen different
 * leaves and filters its own rail per-row, so gating the ENTRY on any one leaf
 * would hide a whole surface from a caller who can still use most of it. This
 * is why the Customize row no longer probes the three capability leaves it
 * used to: it stopped being a link to one page that could 403.
 */

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
 * Customize — the top-of-panel entry, mounted directly under New session.
 * Opens the Customize panel.
 *
 * A button, not a `<Link prefetch>`. The panel is not a route: it floats over
 * whatever project page is active so you keep your place (see
 * settings-panel-store), which is also why active state reads the store rather
 * than the pathname. It used to be a link into `/projects/<id>/connectors`,
 * back when Customize meant three routed capability pages.
 *
 * Sliders, not a second gear: two identical gear rows in one panel read as a
 * duplicate, not as two ways in. No keycap either — Mod+, is printed on the
 * Settings row, and one shortcut advertised on two rows is a lie on one of them.
 */
export function ProjectCustomizeNavItem() {
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const openCustomize = useSettingsPanelStore((s) => s.openCustomize);
  const isActive = useSettingsPanelStore((s) => s.open && s.surface === 'customize');

  const handleClick = useCallback(() => {
    openCustomize();
    if (isMobile) setOpenMobile(false);
  }, [openCustomize, isMobile, setOpenMobile]);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={handleClick}
        isActive={isActive}
        tooltip="Customize"
        className="group/menu-button text-muted-foreground hover:text-sidebar-foreground flex items-center gap-2 px-3 text-sm! font-medium [&_svg]:size-4!"
      >
        <>
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
        </>
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
  // Both rows open the same overlay, so `open` alone would light BOTH of them
  // whenever either was showing. The surface is what tells them apart.
  const isActive = useSettingsPanelStore((s) => s.open && s.surface === 'settings');
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
