import { create } from 'zustand';
import type { SettingsTabId } from '@/lib/menu-registry';

/**
 * Single source of truth for opening the UserSettingsModal from anywhere —
 * used by the error handler to route billing errors straight to the Billing tab
 * (and to highlight credits when the user ran out). Mounted once globally via
 * `GlobalUserSettingsModal` in app-providers.
 */

export type UserSettingsHighlight = 'credits' | null;

interface UserSettingsModalState {
  isOpen: boolean;
  defaultTab: SettingsTabId;
  highlight: UserSettingsHighlight;
  openUserSettings: (opts?: {
    tab?: SettingsTabId;
    highlight?: UserSettingsHighlight;
  }) => void;
  closeUserSettings: () => void;
}

export const useUserSettingsModalStore = create<UserSettingsModalState>((set) => ({
  isOpen: false,
  defaultTab: 'general',
  highlight: null,
  openUserSettings: (opts) =>
    set({
      isOpen: true,
      defaultTab: opts?.tab ?? 'general',
      highlight: opts?.highlight ?? null,
    }),
  closeUserSettings: () => set({ isOpen: false, highlight: null }),
}));
