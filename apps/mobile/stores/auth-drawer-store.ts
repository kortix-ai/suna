import { create } from 'zustand';

interface AuthDrawerState {
  isOpen: boolean;
  title?: string;
  message?: string;
  onSuccess?: () => void;
  openAuthDrawer: (options?: { title?: string; message?: string; onSuccess?: () => void }) => void;
  closeAuthDrawer: () => void;
}

export const useAuthDrawerStore = create<AuthDrawerState>((set) => ({
  isOpen: false,
  title: undefined,
  message: undefined,
  onSuccess: undefined,
  openAuthDrawer: (options) =>
    set({
      isOpen: true,
      title: options?.title || 'Create an Account',
      message: options?.message || 'Sign up or log in to continue',
      onSuccess: options?.onSuccess,
    }),
  closeAuthDrawer: () =>
    set({
      isOpen: false,
      title: undefined,
      message: undefined,
      onSuccess: undefined,
    }),
}));

