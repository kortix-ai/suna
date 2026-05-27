import { create } from 'zustand';

export type UpgradeReason = 'subscription_required' | 'insufficient_credits' | 'no_account';

interface UpgradeDialogState {
  isOpen: boolean;
  reason: UpgradeReason;
  message: string;
  balance: number;
  openUpgradeDialog: (opts: {
    reason?: UpgradeReason;
    message?: string;
    balance?: number;
  }) => void;
  closeUpgradeDialog: () => void;
}

export const useUpgradeDialogStore = create<UpgradeDialogState>((set) => ({
  isOpen: false,
  reason: 'subscription_required',
  message: '',
  balance: 0,
  openUpgradeDialog: (opts) =>
    set({
      isOpen: true,
      reason: opts.reason ?? 'subscription_required',
      message: opts.message ?? '',
      balance: opts.balance ?? 0,
    }),
  closeUpgradeDialog: () => set({ isOpen: false }),
}));
