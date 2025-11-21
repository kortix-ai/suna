import { create } from 'zustand';

type AuthMode = 'choose' | 'sign-in' | 'sign-up';

interface AuthDrawerState {
  isOpen: boolean;
  title?: string;
  message?: string;
  mode?: AuthMode;
  onSuccess?: () => void;
  openAuthDrawer: (options?: { title?: string; message?: string; mode?: AuthMode; onSuccess?: () => void }) => void;
  closeAuthDrawer: () => void;
}

export const useAuthDrawerStore = create<AuthDrawerState>((set) => ({
  isOpen: false,
  title: undefined,
  message: undefined,
  mode: undefined,
  onSuccess: undefined,
  openAuthDrawer: (options) =>
    set({
      isOpen: true,
      title: options?.title,
      message: options?.message,
      mode: options?.mode,
      onSuccess: options?.onSuccess,
    }),
  closeAuthDrawer: () =>
    set({
      isOpen: false,
      title: undefined,
      message: undefined,
      mode: undefined,
      onSuccess: undefined,
    }),
}));

