import { create } from 'zustand';
import type { SettingsTabId } from '@/lib/menu-registry';
import { useCurrentAccountStore } from '@/stores/current-account-store';

/**
 * Account-level settings live at `/accounts/[id]` — Overview, Billing,
 * Transactions, Members, etc. Keep a tiny action store so existing callers can
 * route to the account page with the requested tab in the URL.
 */

type AccountSettingsHighlight = 'credits' | null;

/** Tabs that can be deep-linked on /accounts/[id]. */
type AccountSettingsTabId = Extract<
  SettingsTabId,
  'billing' | 'transactions'
>;

interface AccountSettingsModalState {
  openAccountSettings: (opts?: {
    tab?: AccountSettingsTabId;
    highlight?: AccountSettingsHighlight;
  }) => void;
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

export const useAccountSettingsModalStore = create<AccountSettingsModalState>(() => ({
  openAccountSettings: (opts) => {
    const tab = opts?.tab ?? 'billing';
    const highlight = opts?.highlight ?? null;
    navigateToAccountTab(tab, highlight);
  },
}));
