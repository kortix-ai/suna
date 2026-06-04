import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type SoundEvent = 'completion' | 'error' | 'notification' | 'send';
export type SoundPack = 'off' | 'opencode' | 'kortix';

export interface SoundPreferences {
  pack: SoundPack;
  volume: number;
  events: Partial<Record<SoundEvent, boolean>>;
  hapticsEnabled: boolean;
}

interface SoundState {
  preferences: SoundPreferences;
  setPack: (pack: SoundPack) => void;
  setVolume: (volume: number) => void;
  setEventEnabled: (event: SoundEvent, enabled: boolean) => void;
  setHapticsEnabled: (enabled: boolean) => void;
  isEventEnabled: (event: SoundEvent) => boolean;
}

const DEFAULT_PREFERENCES: SoundPreferences = {
  pack: 'kortix',
  volume: 0.5,
  events: {},
  hapticsEnabled: true,
};

export const useSoundStore = create<SoundState>()(
  persist(
    (set, get) => ({
      preferences: DEFAULT_PREFERENCES,

      setPack: (pack) => {
        set((state) => ({
          preferences: { ...state.preferences, pack },
        }));
      },

      setVolume: (volume) => {
        set((state) => ({
          preferences: { ...state.preferences, volume: Math.max(0, Math.min(1, volume)) },
        }));
      },

      setEventEnabled: (event, enabled) => {
        set((state) => ({
          preferences: {
            ...state.preferences,
            events: { ...state.preferences.events, [event]: enabled },
          },
        }));
      },

      setHapticsEnabled: (enabled) => {
        set((state) => ({
          preferences: { ...state.preferences, hapticsEnabled: enabled },
        }));
      },

      isEventEnabled: (event) => {
        const { preferences } = get();
        if (preferences.pack === 'off') return false;
        return preferences.events[event] !== false;
      },
    }),
    {
      name: '@sound_preferences',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        preferences: state.preferences,
      }),
    },
  ),
);
