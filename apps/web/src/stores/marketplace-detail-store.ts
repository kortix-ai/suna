import { create } from 'zustand';

interface MarketplaceDetailState {
  /** Catalog id of the open item, or null when the sheet is closed. */
  openId: string | null;
  openItem: (id: string) => void;
  close: () => void;
}

export const useMarketplaceDetailStore = create<MarketplaceDetailState>((set) => ({
  openId: null,
  openItem: (id) => set({ openId: id }),
  close: () => set({ openId: null }),
}));
