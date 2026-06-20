import { create } from 'zustand';

export type ProviderModalTab = 'providers' | 'connected' | 'models';

interface ProviderModalState {
  isOpen: boolean;
  defaultTab: ProviderModalTab;
  openProviderModal: (tab?: ProviderModalTab) => void;
  closeProviderModal: () => void;
}

export const useProviderModalStore = create<ProviderModalState>((set) => ({
  isOpen: false,
  defaultTab: 'providers',
  openProviderModal: (tab = 'providers') =>
    set({ isOpen: true, defaultTab: tab }),
  closeProviderModal: () =>
    set({ isOpen: false }),
}));
