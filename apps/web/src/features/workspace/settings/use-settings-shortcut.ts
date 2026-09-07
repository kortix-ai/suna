'use client';

/**
 * The React half of Mod+, — see `settings-shortcut.ts` for the match itself and
 * for why the keystroke is homed with the panel rather than with the sidebar.
 * Split in two so the pure constants stay importable from a component that
 * renders without a React harness.
 *
 * `useOptionalSidebar`, not `useSidebar`: `StandaloneSettingsRoute` renders the
 * panel with no `SidebarProvider` above it, and the throwing hook would take
 * the whole route down.
 */

import { useEffect } from 'react';

import { useOptionalSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { matchesSettingsShortcut } from './settings-shortcut';

/**
 * Bind Mod+, for as long as the caller is mounted. Mounted by `SettingsPanel`
 * itself, so there is one binding per panel and no way to advertise the
 * keystroke on a surface that cannot answer it.
 */
export function useSettingsKeyboardShortcut() {
  const openSettings = useSettingsPanelStore((s) => s.openSettings);
  const isMobile = useIsMobile();
  const sidebar = useOptionalSidebar();
  const setOpenMobile = sidebar?.setOpenMobile;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!matchesSettingsShortcut(event)) return;
      // Taken back from the browser and from the desktop shell's own
      // Preferences binding — the app's Settings is what the user is asking
      // for from inside the app.
      event.preventDefault();
      openSettings();
      // The mobile sidebar is a Sheet. Leaving it up would stack the
      // full-screen overlay on top of an open drawer, and closing the overlay
      // would reveal it again.
      if (isMobile) setOpenMobile?.(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openSettings, isMobile, setOpenMobile]);
}
