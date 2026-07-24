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
  /** From the 402 body — lets the modal show the top-up view (Team/paid wallet
   *  drained) vs the Free-plan pitch (no plan) without guessing off tier_key,
   *  which stays 'free' for per-seat accounts. */
  billingModel?: string;
  hasSubscription?: boolean;
  openUpgradeDialog: (opts: {
    reason?: UpgradeReason;
    message?: string;
    balance?: number;
    accountId?: string;
    billingModel?: string;
    hasSubscription?: boolean;
  }) => void;
  closeUpgradeDialog: () => void;
}

export const useUpgradeDialogStore = create<UpgradeDialogState>((set) => ({
  isOpen: false,
  reason: 'subscription_required',
  message: '',
  balance: 0,
  accountId: undefined,
  billingModel: undefined,
  hasSubscription: undefined,
  openUpgradeDialog: (opts) =>
    set({
      isOpen: true,
      reason: opts.reason ?? 'subscription_required',
      message: opts.message ?? '',
      balance: opts.balance ?? 0,
      accountId: opts.accountId,
      billingModel: opts.billingModel,
      hasSubscription: opts.hasSubscription,
    }),
  closeUpgradeDialog: () => set({ isOpen: false }),
}));
