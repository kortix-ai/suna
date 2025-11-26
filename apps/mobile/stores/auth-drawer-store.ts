import { create } from 'zustand';

type AuthMode = 'choose' | 'email-auth' | 'sign-in' | 'sign-up';

interface AuthDrawerState {
  isOpen: boolean;
  title?: string;
  message?: string;
  mode?: AuthMode;
  onSuccess?: () => void;
  onSignUpSuccess?: (email: string) => void;
  openAuthDrawer: (options?: { title?: string; message?: string; mode?: AuthMode; onSuccess?: () => void; onSignUpSuccess?: (email: string) => void }) => void;
  closeAuthDrawer: () => void;
}

export const useAuthDrawerStore = create<AuthDrawerState>((set) => ({
  isOpen: false,
  title: undefined,
  message: undefined,
  mode: undefined,
  onSuccess: undefined,
  onSignUpSuccess: undefined,
  openAuthDrawer: (options) =>
    set({
      isOpen: true,
      title: options?.title,
      message: options?.message,
      mode: options?.mode,
      onSuccess: options?.onSuccess,
      onSignUpSuccess: options?.onSignUpSuccess,
    }),
  closeAuthDrawer: () =>
    set({
      isOpen: false,
      title: undefined,
      message: undefined,
      mode: undefined,
      onSuccess: undefined,
      onSignUpSuccess: undefined,
    }),
}));

