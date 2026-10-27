'use client';

import { create } from 'zustand';

/** "Apps and extensions" dialog: any trigger (account menu, sidebar row, `?apps=1`) opens the one mounted in the project sidebar. */
interface AppsModalState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useAppsModalStore = create<AppsModalState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
