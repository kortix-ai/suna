'use client';

/**
 * Settings overlay store.
 *
 * Settings is a full-screen overlay that floats over whatever project page is
 * active (a session, the project home, …) instead of a route that swaps the
 * content area and spawns a tab. Keeping the open/tab state here lets every
 * trigger — the sidebar button, project-home tiles, the command palette, the
 * user menu, deep-link routes — open the same surface without navigating, so
 * you never lose your place. ESC / backdrop closes it and you're exactly
 * where you were.
 *
 * This is a NEW store, alongside the legacy Customize store — it is not a
 * rename and not a re-export shim of it. The legacy store keeps the legacy
 * panel working (`CustomizeSection` ids: `git`, `commands`, `settings`,
 * `llm-management`, `upgrade`, ...) until the cutover task deletes both the
 * legacy panel and this comment's caveat. See `settings-tabs.ts`'s header for
 * why the two id vocabularies cannot be aliased together.
 */

import { create } from 'zustand';

import { DEFAULT_SETTINGS_TAB, type SettingsTab } from '@/features/workspace/settings/settings-tabs';

/** Sub-tab to land on inside the Members section when deep-linking there.
 *  "People" is the primary surface, so it's the default. Mirrors
 *  the legacy Customize store's `MembersTab` — kept as an independent declaration
 *  rather than an import, so the two stores stay decoupled while they coexist. */
export type MembersTab = 'people' | 'invite';

/**
 * `llmProvidersTab` on the legacy store has NO equivalent field here. Task 4
 * established that the merged `models` tab's internal sub-navigation
 * (Providers / Overview / Logs / Budgets / Keys / API) is separate LOCAL
 * state owned by whichever component renders that tab's content, not a rail
 * tab or a panel-store field — there is no `llm-*` id left once
 * `legacySectionRedirect` folds all of them into `models`.
 */
interface SettingsPanelOptions {
  /** When jumping to `members`, which sub-tab to open (e.g. straight to Invite). */
  membersTab?: MembersTab;
}

interface SettingsPanelState {
  open: boolean;
  /** The currently-shown tab. Persists between opens so reopening returns you
   *  to the last tab you were on. */
  tab: SettingsTab;
  /** Which sub-tab the Members tab should land on. Reset to "people" on every
   *  open unless a trigger explicitly asks otherwise (e.g. Invite). */
  membersTab: MembersTab;
  /** Open the overlay. Pass a tab to jump straight to it; omit to resume
   *  wherever you left off. */
  openSettings: (tab?: SettingsTab, opts?: SettingsPanelOptions) => void;
  setTab: (tab: SettingsTab) => void;
  close: () => void;
}

export const useSettingsPanelStore = create<SettingsPanelState>((set) => ({
  open: false,
  tab: DEFAULT_SETTINGS_TAB,
  membersTab: 'people',
  openSettings: (tab, opts) =>
    set((s) => ({
      open: true,
      tab: tab ?? s.tab,
      membersTab: opts?.membersTab ?? 'people',
    })),
  setTab: (tab) => set({ tab }),
  close: () => set({ open: false }),
}));
