import { create } from 'zustand';

export type UpgradeReason = 'subscription_required' | 'insufficient_credits' | 'no_account';

interface UpgradeDialogState {
  isOpen: boolean;
  reason: UpgradeReason;
  message: string;
  balance: number;
  /** The account that actually needs the upgrade (the blocked account from the
   *  402 — e.g. the project's owning team account). `undefined` falls back to the
   *  user's primary account. The dialog scopes its billing state + subscribe
   *  action to this, so a non-billing member sees the *team's* gated CTA, not
   *  their own personal account's. */
  accountId?: string;
  openUpgradeDialog: (opts: {
    reason?: UpgradeReason;
    message?: string;
    balance?: number;
    accountId?: string;
  }) => void;
  closeUpgradeDialog: () => void;
}

export const useUpgradeDialogStore = create<UpgradeDialogState>((set) => ({
  isOpen: false,
  reason: 'subscription_required',
  message: '',
  balance: 0,
  accountId: undefined,
  openUpgradeDialog: (opts) =>
    set({
      isOpen: true,
      reason: opts.reason ?? 'subscription_required',
      message: opts.message ?? '',
      balance: opts.balance ?? 0,
      accountId: opts.accountId,
    }),
  closeUpgradeDialog: () => set({ isOpen: false }),
}));
