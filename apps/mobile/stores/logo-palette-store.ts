/**
 * The user's choice of style and colours for the Kortix symbol on the project
 * home (`MetalKortixLogo`, `lib/effects/logo-style`, `lib/effects/logo-palette`).
 * Kept on the device. Set from the hidden sheet behind a 5-second press on
 * the symbol.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  DEFAULT_LOGO_PALETTE_ID,
  isLogoPaletteId,
  type LogoPaletteId,
} from '@/lib/effects/logo-palette';
import { DEFAULT_LOGO_STYLE_ID, isLogoStyleId, type LogoStyleId } from '@/lib/effects/logo-style';

interface LogoPaletteState {
  styleId: LogoStyleId;
  paletteId: LogoPaletteId;
  setStyleId: (styleId: LogoStyleId) => void;
  setPaletteId: (paletteId: LogoPaletteId) => void;
}

export const useLogoPaletteStore = create<LogoPaletteState>()(
  persist(
    (set) => ({
      styleId: DEFAULT_LOGO_STYLE_ID,
      paletteId: DEFAULT_LOGO_PALETTE_ID,
      setStyleId: (styleId) => set({ styleId }),
      setPaletteId: (paletteId) => set({ paletteId }),
    }),
    {
      name: 'kortix-logo-palette',
      storage: createJSONStorage(() => AsyncStorage),
      // A style or palette removed in a later version falls back to the default.
      merge: (persisted, current) => {
        const saved = persisted as Partial<LogoPaletteState> | undefined;
        return {
          ...current,
          styleId: isLogoStyleId(saved?.styleId) ? saved.styleId : DEFAULT_LOGO_STYLE_ID,
          paletteId: isLogoPaletteId(saved?.paletteId) ? saved.paletteId : DEFAULT_LOGO_PALETTE_ID,
        };
      },
    }
  )
);
