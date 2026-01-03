import { create } from 'zustand';
import { trackCtaUpgrade } from '@/lib/analytics/gtm';

interface PricingModalState {
  isOpen: boolean;
  customTitle?: string;
  isAlert?: boolean;
  alertTitle?: string;
  alertSubtitle?: string;
  returnUrl?: string;
  openPricingModal: (options?: { title?: string; returnUrl?: string, isAlert?: boolean, alertTitle?: string, alertSubtitle?: string }) => void;
  closePricingModal: () => void;
}

export const usePricingModalStore = create<PricingModalState>((set) => ({
  isOpen: false,
  isAlert: false,
  customTitle: undefined,
  alertSubtitle: undefined,
  returnUrl: undefined,
  openPricingModal: (options) => {
    // Track cta_upgrade event for GTM/GA4
    trackCtaUpgrade();
    
    set({
      isOpen: true,
      customTitle: options?.title,
      isAlert: options?.isAlert || false,
      alertTitle: options?.alertTitle,
      alertSubtitle: options?.alertSubtitle,
      returnUrl: options?.returnUrl,
    });
  },
  closePricingModal: () =>
    set({
      isOpen: false,
      customTitle: undefined,
      isAlert: false,
      alertTitle: undefined,
      alertSubtitle: undefined,
      returnUrl: undefined,
    }),
}));
