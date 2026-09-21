/**
 * The user's choice of colours for the liquid-metal Kortix symbol
 * (`MetalKortixLogo`, `lib/effects/logo-palette`). Kept on the device. Set from
 * the hidden sheet behind a 10-second press on the project home symbol.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  DEFAULT_LOGO_PALETTE_ID,
  isLogoPaletteId,
  type LogoPaletteId,
} from '@/lib/effects/logo-palette';

interface LogoPaletteState {
  paletteId: LogoPaletteId;
  setPaletteId: (paletteId: LogoPaletteId) => void;
}

export const useLogoPaletteStore = create<LogoPaletteState>()(
  persist(
    (set) => ({
      paletteId: DEFAULT_LOGO_PALETTE_ID,
      setPaletteId: (paletteId) => set({ paletteId }),
    }),
    {
      name: 'kortix-logo-palette',
      storage: createJSONStorage(() => AsyncStorage),
      // A palette removed in a later version falls back to the default metal.
      merge: (persisted, current) => {
        const saved = (persisted as Partial<LogoPaletteState> | undefined)?.paletteId;
        return { ...current, paletteId: isLogoPaletteId(saved) ? saved : DEFAULT_LOGO_PALETTE_ID };
      },
    }
  )
);
