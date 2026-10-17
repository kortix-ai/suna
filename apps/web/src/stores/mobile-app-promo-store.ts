import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createSafeJSONStorage } from '@/lib/storage/managed-storage';
import { registerPersistedStore, resetPersistedStore } from '@/stores/persisted-store-registry';

/**
 * Whether this browser closed the "Kortix mobile" introduction on the project
 * page (`features/mobile-app/mobile-app-promo.tsx`). Closed once, it stays
 * closed: the X, Escape, a click outside and a store button all count.
 */

/** `kortix.` is an app prefix, so sign-out sweeps it
 *  (`persisted-store-coverage.test.ts`). */
const STORAGE_KEY = 'kortix.mobileAppPromo';

interface MobileAppPromoState {
  closed: boolean;
  close: () => void;
}

export const useMobileAppPromoStore = create<MobileAppPromoState>()(
  persist(
    (set) => ({
      closed: false,
      close: () => set({ closed: true }),
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      version: 1,
      partialize: (state) => ({ closed: state.closed }),
    },
  ),
);

registerPersistedStore(STORAGE_KEY, () => resetPersistedStore(useMobileAppPromoStore));
