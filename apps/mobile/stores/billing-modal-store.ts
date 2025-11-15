import { create } from 'zustand';

interface PricingModalState {
  isOpen: boolean;
  alertTitle?: string;
  creditsExhausted?: boolean;
  openPricingModal: (options?: { alertTitle?: string; creditsExhausted?: boolean }) => void;
  closePricingModal: () => void;
}

export const usePricingModalStore = create<PricingModalState>((set) => ({
  isOpen: false,
  alertTitle: undefined,
  creditsExhausted: false,
  openPricingModal: (options) =>
    set({
      isOpen: true,
      alertTitle: options?.alertTitle,
      creditsExhausted: options?.creditsExhausted || false,
    }),
  closePricingModal: () =>
    set({
      isOpen: false,
      alertTitle: undefined,
      creditsExhausted: false,
    }),
}));

export const useBillingModalStore = usePricingModalStore;

