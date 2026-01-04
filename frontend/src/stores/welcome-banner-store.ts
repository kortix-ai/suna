import { create } from 'zustand';

interface WelcomeBannerState {
  isVisible: boolean;
  setIsVisible: (visible: boolean) => void;
}

export const useWelcomeBannerStore = create<WelcomeBannerState>((set) => ({
  isVisible: false,
  setIsVisible: (visible) => set({ isVisible: visible }),
}));


