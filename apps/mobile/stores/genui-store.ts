import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface GenuiState {
  /** Render generative UI blocks as UI (true) or as their markdown fallback (false). */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

/** A device preference, like the theme: it survives sign-out (lib/auth/sign-out-keys.ts). */
export const useGenuiStore = create<GenuiState>()(
  persist(
    (set) => ({
      enabled: true,
      setEnabled: (enabled) => set({ enabled }),
    }),
    { name: 'kortix-genui', storage: createJSONStorage(() => AsyncStorage) },
  ),
);
