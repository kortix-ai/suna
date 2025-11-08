import { create } from 'zustand';

interface PricingModalState {
  isOpen: boolean;
  customTitle?: string;
  returnUrl?: string;
  openPricingModal: (options?: { title?: string; returnUrl?: string }) => void;
  closePricingModal: () => void;
}

export const usePricingModalStore = create<PricingModalState>((set) => ({
  isOpen: false,
  customTitle: undefined,
  returnUrl: undefined,
  openPricingModal: (options) =>
    set({
      isOpen: true,
      customTitle: options?.title,
      returnUrl: options?.returnUrl,
    }),
  closePricingModal: () =>
    set({
      isOpen: false,
      customTitle: undefined,
      returnUrl: undefined,
    }),
}));
