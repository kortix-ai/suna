import { create } from 'zustand';
import { trackCtaUpgrade } from '@/lib/analytics/gtm';

/**
 * Store for the "New Instance" modal.
 */

interface NewInstanceModalState {
  isOpen: boolean;
  title?: string;
  openNewInstanceModal: (title?: string) => void;
  closeNewInstanceModal: () => void;
}

export const useNewInstanceModalStore = create<NewInstanceModalState>((set) => ({
  isOpen: false,
  title: undefined,
  openNewInstanceModal: (title?: string) => {
    trackCtaUpgrade();
    set({ isOpen: true, title });
  },
  closeNewInstanceModal: () => set({ isOpen: false, title: undefined }),
}));
