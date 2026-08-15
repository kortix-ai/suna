'use client';

/**
 * Panel store — Customize and Settings.
 *
 * Both are full-screen overlays that float over whatever project page is
 * active (a session, the project home, …) instead of routes that swap the
 * content area. Keeping the open/surface/tab state here lets every trigger —
 * the sidebar buttons, project-home tiles, the command palette, the user menu,
 * deep-link routes — open the right surface without navigating, so you never
 * lose your place. ESC / backdrop closes it and you're exactly where you were.
 *
 * ONE store for both, not two, because they are one shell and one rail
 * mechanic showing two different sets of rows (`settings-tabs.ts` →
 * `TAB_SURFACE`). Two stores would let both overlays be open at once, each
 * with its own idea of the active tab.
 *
 * **A tab decides its own surface.** `openSettings('secrets')` opens
 * Customize, because Secrets is a Customize pane. That is why moving a pane
 * between surfaces needs no call-site changes anywhere: every trigger names a
 * tab, and the tab names the surface.
 */

import { create } from 'zustand';

import {
  DEFAULT_CUSTOMIZE_TAB,
  DEFAULT_SETTINGS_TAB,
  TAB_SURFACE,
  type SettingsSurface,
  type SettingsTab,
} from '@/features/workspace/settings/settings-tabs';

/** Sub-tab to land on inside the Members section when deep-linking there.
 *  "People" is the primary surface, so it's the default. */
export type MembersTab = 'people' | 'invite';

/**
 * The `models` pane's internal sub-navigation (Providers / Overview / Logs /
 * Budgets / Keys / API) is LOCAL state owned by that pane, not a rail tab and
 * not a field here — there is no `llm-*` id left once `legacySectionRedirect`
 * folds all of them into `models`.
 */
interface SettingsPanelOptions {
  /** When jumping to `members`, which sub-tab to open (e.g. straight to Invite). */
  membersTab?: MembersTab;
}

interface SettingsPanelState {
  open: boolean;
  /** Which of the two panels is showing. */
  surface: SettingsSurface;
  /** The currently-shown tab. Always a tab of `surface`. */
  tab: SettingsTab;
  /**
   * The last tab visited on each surface, so reopening either one returns you
   * where you left off — independently. Opening Customize must not drop you on
   * the Billing tab because that is where you were in Settings an hour ago.
   */
  lastTab: Record<SettingsSurface, SettingsTab>;
  /** Which sub-tab the Members tab should land on. Reset to "people" on every
   *  open unless a trigger explicitly asks otherwise (e.g. Invite). */
  membersTab: MembersTab;
  /** Open Settings. Pass a tab to jump straight to it; omit to resume where
   *  you left off. A tab that belongs to Customize opens Customize. */
  openSettings: (tab?: SettingsTab, opts?: SettingsPanelOptions) => void;
  /** Open Customize. Same rules, mirrored. */
  openCustomize: (tab?: SettingsTab, opts?: SettingsPanelOptions) => void;
  setTab: (tab: SettingsTab) => void;
  close: () => void;
}

export const useSettingsPanelStore = create<SettingsPanelState>((set) => {
  const openOn =
    (fallback: SettingsSurface) => (tab?: SettingsTab, opts?: SettingsPanelOptions) =>
      set((s) => {
        const surface = tab ? TAB_SURFACE[tab] : fallback;
        const next = tab ?? s.lastTab[surface];
        return {
          open: true,
          surface,
          tab: next,
          lastTab: { ...s.lastTab, [surface]: next },
          membersTab: opts?.membersTab ?? 'people',
        };
      });

  return {
    open: false,
    surface: 'settings',
    tab: DEFAULT_SETTINGS_TAB,
    lastTab: { settings: DEFAULT_SETTINGS_TAB, customize: DEFAULT_CUSTOMIZE_TAB },
    membersTab: 'people',
    openSettings: openOn('settings'),
    openCustomize: openOn('customize'),
    setTab: (tab) =>
      set((s) => {
        const surface = TAB_SURFACE[tab];
        return { tab, surface, lastTab: { ...s.lastTab, [surface]: tab } };
      }),
    close: () => set({ open: false }),
  };
});
