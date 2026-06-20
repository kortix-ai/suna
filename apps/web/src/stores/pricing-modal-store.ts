import { create } from 'zustand';
import { trackCtaUpgrade } from '@/lib/analytics/gtm';

/**
 * Store for the "New Instance" modal.
 * Renamed from pricing-modal-store. Same file path kept to avoid mass import changes.
 */

interface NewInstanceModalState {
  isOpen: boolean;
  title?: string;
  openNewInstanceModal: (title?: string) => void;
  closeNewInstanceModal: () => void;
  // Compat aliases used by old callers
  openPricingModal: (opts?: { title?: string; isAlert?: boolean; alertTitle?: string }) => void;
  closePricingModal: () => void;
}

export const useNewInstanceModalStore = create<NewInstanceModalState>((set) => ({
  isOpen: false,
  title: undefined,
  openNewInstanceModal: (title?: string) => {
    trackCtaUpgrade();
    set({ isOpen: true, title });
  },
  closeNewInstanceModal: () => set({ isOpen: false, title: undefined }),
  // Compat
  openPricingModal: (opts) => {
    trackCtaUpgrade();
    set({ isOpen: true, title: opts?.alertTitle || opts?.title });
  },
  closePricingModal: () => set({ isOpen: false, title: undefined }),
}));

// Old name — still imported by ~10 files. Points to the same store.
export const usePricingModalStore = useNewInstanceModalStore;
