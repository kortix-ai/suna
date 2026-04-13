import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type AppearanceThemeId =
  | 'graphite'
  | 'teal'
  | 'amber'
  | 'rose'
  | 'violet'
  | 'emerald'
  | 'neon';

export type WallpaperId = 'brandmark' | 'symbol' | 'aurora';

interface AppearanceState {
  themeId: AppearanceThemeId;
  wallpaperId: WallpaperId;
  setThemeId: (themeId: AppearanceThemeId) => void;
  setWallpaperId: (wallpaperId: WallpaperId) => void;
  reset: () => void;
}

export const DEFAULT_APPEARANCE_THEME: AppearanceThemeId = 'graphite';
export const DEFAULT_WALLPAPER: WallpaperId = 'aurora';

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      themeId: DEFAULT_APPEARANCE_THEME,
      wallpaperId: DEFAULT_WALLPAPER,

      setThemeId: (themeId) => set({ themeId }),
      setWallpaperId: (wallpaperId) => set({ wallpaperId }),

      reset: () => set({
        themeId: DEFAULT_APPEARANCE_THEME,
        wallpaperId: DEFAULT_WALLPAPER,
      }),
    }),
    {
      name: '@appearance_preferences',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        themeId: state.themeId,
        wallpaperId: state.wallpaperId,
      }),
    },
  ),
);
