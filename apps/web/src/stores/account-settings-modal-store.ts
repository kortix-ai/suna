import type { SettingsTabId } from '@/lib/menu-registry';
import { hubTarget, openAccountPanel, type HubTarget } from '@/stores/account-panel-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { create } from 'zustand';

/**
 * Account-level settings — Billing, Usage — live in the account hub modal,
 * addressed by `?accountId=` on whatever page you are on
 * (`stores/account-panel-store.ts`). The legacy modal was removed long ago and
 * this store then navigated to `/accounts/[id]`; that route was deleted on
 * 2026-09-08, so it opens the modal instead. The `openAccountSettings(...)`
 * call shape is preserved for its existing callers — the user menu, the error
 * handler, the upgrade dialog, the session error banner.
 *
 * `isOpen` / `defaultTab` are vestigial — kept so any straggling subscribers
 * don't blow up — but nothing renders off them.
 */

export type AccountSettingsHighlight = 'credits' | null;

/** Account-scoped tabs a caller here can ask for. */
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

/**
 * The hub destination for an account settings tab.
 *
 * Exported so a control that already knows where it is going renders a
 * `HubLink` — a real anchor, with the chunk warmed on hover — instead of a
 * button. Pass `accountId` when the caller holds a reactive one; otherwise the
 * current selection is read from the store.
 *
 * With no account selected this targets the hub's account LIST, which is the
 * honest destination: pick one first. That branch is live —
 * `selectedAccountId` starts null in a fresh browser or a storage-blocked
 * context.
 *
 * `highlight` is deliberately NOT carried onto the URL. It never was read from
 * there: `billing-tab.tsx` reads it from `user-settings-modal-store`, and the
 * `?highlight=` this used to append was dead the day it was written.
 */
export function accountSettingsTarget(opts?: {
  tab?: AccountSettingsTabId;
  accountId?: string | null;
}): HubTarget {
  const accountId =
    opts?.accountId !== undefined
      ? opts.accountId
      : useCurrentAccountStore.getState().selectedAccountId;
  if (!accountId) return hubTarget(null);
  return hubTarget(accountId, { tab: opts?.tab ?? 'billing' });
}

export const useAccountSettingsModalStore = create<AccountSettingsModalState>((set) => ({
  isOpen: false,
  defaultTab: 'billing',
  highlight: null,
  openAccountSettings: (opts) => {
    const tab = opts?.tab ?? 'billing';
    set({ isOpen: false, defaultTab: tab, highlight: opts?.highlight ?? null });
    // Opens over whatever page the caller is on — an error toast fires from
    // anywhere, and this must not move the person off their session.
    openAccountPanel(accountSettingsTarget({ tab }));
  },
  closeAccountSettings: () => set({ isOpen: false, highlight: null }),
}));
