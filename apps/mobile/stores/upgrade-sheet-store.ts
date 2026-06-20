import { create } from 'zustand';
import type { UpgradeGateReason } from '@/lib/billing/upgrade-gate';

interface UpgradeSheetState {
  isOpen: boolean;
  reason: UpgradeGateReason | null;
  accountId: string | null;
  message: string | null;
  openUpgradeSheet: (options: {
    reason: UpgradeGateReason;
    accountId?: string;
    message: string;
  }) => void;
  closeUpgradeSheet: () => void;
}

export const useUpgradeSheetStore = create<UpgradeSheetState>((set) => ({
  isOpen: false,
  reason: null,
  accountId: null,
  message: null,
  openUpgradeSheet: ({ reason, accountId, message }) =>
    set({
      isOpen: true,
      reason,
      accountId: accountId ?? null,
      message,
    }),
  closeUpgradeSheet: () =>
    set({
      isOpen: false,
      reason: null,
      accountId: null,
      message: null,
    }),
}));
