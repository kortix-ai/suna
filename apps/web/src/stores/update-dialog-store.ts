import { create } from 'zustand';

interface UpdateDialogStore {
  open: boolean;
  /** When set, the dialog should install this specific version instead of latest */
  targetVersion: string | null;
  openDialog: (targetVersion?: string) => void;
  closeDialog: () => void;
}

export const useUpdateDialogStore = create<UpdateDialogStore>((set) => ({
  open: false,
  targetVersion: null,
  openDialog: (targetVersion?: string) => set({ open: true, targetVersion: targetVersion ?? null }),
  closeDialog: () => set({ open: false, targetVersion: null }),
}));
