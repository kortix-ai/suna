import { create } from 'zustand';
import type { SettingsTabId } from '@/lib/menu-registry';
import { softNavigate } from '@/lib/navigation/router-bridge';
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

/**
 * The `/accounts/[id]` URL for a settings tab.
 *
 * Exported so a control that already knows its destination at render time
 * renders a `<Link>` instead of a button — an anchor is prefetched, a button is
 * not. Pass `accountId` when the caller holds a reactive one; otherwise the
 * current selection is read from the store.
 *
 * Falls back to the accounts picker when no account is selected. That branch is
 * live: `selectedAccountId` starts null in a fresh browser or a
 * storage-blocked context.
 */
export function buildAccountSettingsHref(opts?: {
  tab?: AccountSettingsTabId;
  highlight?: AccountSettingsHighlight;
  accountId?: string | null;
}): string {
  const accountId =
    opts?.accountId !== undefined
      ? opts.accountId
      : useCurrentAccountStore.getState().selectedAccountId;
  if (!accountId) return '/accounts';
  const params = new URLSearchParams({ tab: opts?.tab ?? 'billing' });
  if (opts?.highlight) params.set('highlight', opts.highlight);
  return `/accounts/${accountId}?${params.toString()}`;
}

function navigateToAccountTab(tab: AccountSettingsTabId, highlight: AccountSettingsHighlight) {
  if (typeof window === 'undefined') return;
  // A store is not a component, so it cannot hold a router. The bridge carries
  // the live one — `window.location.href` here rebooted the whole SPA.
  softNavigate(buildAccountSettingsHref({ tab, highlight }));
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
