import { create } from 'zustand';

interface SSHDialogState {
  isOpen: boolean;
  openSSHDialog: () => void;
  closeSSHDialog: () => void;
  setOpen: (open: boolean) => void;
}

export const useSSHDialogStore = create<SSHDialogState>((set) => ({
  isOpen: false,
  openSSHDialog: () => set({ isOpen: true }),
  closeSSHDialog: () => set({ isOpen: false }),
  setOpen: (open: boolean) => set({ isOpen: open }),
}));
