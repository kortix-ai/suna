import { create } from 'zustand';

interface PricingModalState {
  isOpen: boolean;
  customTitle?: string;
  isAlert?: boolean;
  alertTitle?: string;
  returnUrl?: string;
  openPricingModal: (options?: { title?: string; returnUrl?: string, isAlert?: boolean, alertTitle?: string }) => void;
  closePricingModal: () => void;
}

export const usePricingModalStore = create<PricingModalState>((set) => ({
  isOpen: false,
  isAlert: false,
  customTitle: undefined,
  returnUrl: undefined,
  openPricingModal: (options) =>
    set({
      isOpen: true,
      customTitle: options?.title,
      isAlert: options?.isAlert || false,
      alertTitle: options?.alertTitle,
      returnUrl: options?.returnUrl,
    }),
  closePricingModal: () =>
    set({
      isOpen: false,
      customTitle: undefined,
      isAlert: false,
      alertTitle: undefined,
      returnUrl: undefined,
    }),
}));
