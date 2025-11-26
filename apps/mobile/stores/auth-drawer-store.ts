import { create } from 'zustand';

interface EmailAuthDrawerState {
  isOpen: boolean;
  message?: string;
  onSuccess?: () => void;
  openAuthDrawer: (options?: { message?: string; onSuccess?: () => void }) => void;
  closeAuthDrawer: () => void;
}

export const useAuthDrawerStore = create<EmailAuthDrawerState>((set) => ({
  isOpen: false,
  message: undefined,
  onSuccess: undefined,
  openAuthDrawer: (options) =>
    set({
      isOpen: true,
      message: options?.message,
      onSuccess: options?.onSuccess,
    }),
  closeAuthDrawer: () =>
    set({
      isOpen: false,
      message: undefined,
      onSuccess: undefined,
    }),
}));
