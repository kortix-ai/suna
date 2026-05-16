import { create } from 'zustand';
import type { SettingsTabId } from '@/lib/menu-registry';

/**
 * Single source of truth for opening the AccountSettingsModal from anywhere.
 * Used by the WorkspaceMenu and by the error handler when a 402 / insufficient-
 * credits error needs to route the user directly to Billing.
 *
 * Mounted once globally via `GlobalAccountSettingsModal` in app-providers.
 */

export type AccountSettingsHighlight = 'credits' | null;

/** Tabs that live in the AccountSettingsModal (subset of all SettingsTabIds). */
export type AccountSettingsTabId = Extract<SettingsTabId, 'billing' | 'transactions'>;

interface AccountSettingsModalState {
  isOpen: boolean;
  defaultTab: AccountSettingsTabId;
  highlight: AccountSettingsHighlight;
  openAccountSettings: (opts?: {
    tab?: AccountSettingsTabId;
    highlight?: AccountSettingsHighlight;
  }) => void;
  closeAccountSettings: () => void;
}

export const useAccountSettingsModalStore = create<AccountSettingsModalState>((set) => ({
  isOpen: false,
  defaultTab: 'billing',
  highlight: null,
  openAccountSettings: (opts) =>
    set({
      isOpen: true,
      defaultTab: opts?.tab ?? 'billing',
      highlight: opts?.highlight ?? null,
    }),
  closeAccountSettings: () => set({ isOpen: false, highlight: null }),
}));
