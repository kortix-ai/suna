import { create } from 'zustand';
import type { SettingsTabId } from '@/lib/menu-registry';
import { useCurrentAccountStore } from '@/stores/current-account-store';

/**
 * Account-level settings live at `/accounts/[id]` — Overview, Billing,
 * Transactions, Members, etc. The legacy modal was removed; this store
 * preserves the `openAccountSettings(...)` call shape so existing call sites
 * (user menu, error handler, upgrade dialog, error banner) keep working. It
 * navigates to the account page with the requested tab in the URL.
 *
 * `isOpen` / `defaultTab` are vestigial — kept so any straggling subscribers
 * don't blow up — but nothing renders off them anymore.
 */

export type AccountSettingsHighlight = 'credits' | null;

/** Tabs that can be deep-linked on /accounts/[id]. */
export type AccountSettingsTabId = Extract<
  SettingsTabId,
  'billing' | 'transactions'
>;

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

function navigateToAccountTab(tab: AccountSettingsTabId, highlight: AccountSettingsHighlight) {
  if (typeof window === 'undefined') return;
  const accountId = useCurrentAccountStore.getState().selectedAccountId;
  if (!accountId) {
    // No account selected — drop the user at the accounts picker.
    window.location.href = '/accounts';
    return;
  }
  const params = new URLSearchParams({ tab });
  if (highlight) params.set('highlight', highlight);
  window.location.href = `/accounts/${accountId}?${params.toString()}`;
}

export const useAccountSettingsModalStore = create<AccountSettingsModalState>((set) => ({
  isOpen: false,
  defaultTab: 'billing',
  highlight: null,
  openAccountSettings: (opts) => {
    const tab = opts?.tab ?? 'billing';
    const highlight = opts?.highlight ?? null;
    set({ isOpen: false, defaultTab: tab, highlight });
    navigateToAccountTab(tab, highlight);
  },
  closeAccountSettings: () => set({ isOpen: false, highlight: null }),
}));
