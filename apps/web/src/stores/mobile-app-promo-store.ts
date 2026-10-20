import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * Whether this browser closed the "Kortix mobile" introduction on the project
 * page (`features/workspace/project-layout/home/mobile-app-promo.tsx`). Closed
 * once, it stays closed: the X, Escape, a click outside and a store button all
 * count.
 */

/**
 * The disk key. It is on `KEEP_STORAGE_KEYS` (`clear-local-storage.ts`): a
 * dismissed promo is a device-scoped fact — this browser has seen the pitch —
 * not anything tied to the signed-in identity, so it survives the sign-out
 * sweep and a fresh sign-in never re-asks (KRTX-2640). Being KEPT also means
 * the store must NOT register an in-memory sign-out reset
 * (`persisted-store-coverage.test.ts`): resetting one half and not the other
 * would leave disk and memory disagreeing about a dismissal.
 */
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
