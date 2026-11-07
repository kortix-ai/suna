'use client';

import { createSafeJSONStorage } from '../lib/storage/managed-storage';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ============================================================================
// Types
// ============================================================================

/**
 * Sound event types that can each have individual volume/enabled settings.
 *
 * - `completion`  – session task finishes
 * - `error`       – session error
 * - `notification` – question or permission request
 * - `send`        – user sends a message
 */
export type SoundEvent = 'completion' | 'error' | 'notification' | 'send';

/**
 * Available sound packs.
 *
 * - `off`     – all sounds disabled
 * - `classic` – default sound pack (synthesized tones)
 * - `kortix`  – Kortix branded sound pack
 */
export type SoundPack = 'off' | 'classic' | 'kortix';

export interface SoundPreferences {
  /** Active sound pack — 'off' disables all sounds */
  pack: SoundPack;
  /** Master volume 0-1 */
  volume: number;
  /** Per-event overrides — if missing, defaults to enabled */
  events: Partial<Record<SoundEvent, boolean>>;
}

// ============================================================================
// Store
// ============================================================================

interface SoundState {
  preferences: SoundPreferences;

  /** Set the active sound pack */
  setPack: (pack: SoundPack) => void;

  /** Set master volume (0-1) */
  setVolume: (volume: number) => void;

  /** Toggle a specific sound event on/off */
  setEventEnabled: (event: SoundEvent, enabled: boolean) => void;

  /** Check if a specific event should play sound */
  isEventEnabled: (event: SoundEvent) => boolean;
}

const DEFAULT_PREFERENCES: SoundPreferences = {
  pack: 'off',
  volume: 0.5,
  events: {},
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

      isEventEnabled: (event) => {
        const { preferences } = get();
        if (preferences.pack === 'off') return false;
        return preferences.events[event] !== false;
      },
    }),
    {
      name: 'kortix-sound-preferences',
      // v1 renamed the default pack from 'opencode' to 'classic'. A saved
      // 'opencode' keeps playing the same pack.
      version: 1,
      migrate: (persisted) => {
        const state = persisted as { preferences?: SoundPreferences } | null;
        const preferences = { ...DEFAULT_PREFERENCES, ...state?.preferences };
        if ((preferences.pack as string) === 'opencode') preferences.pack = 'classic';
        return { preferences } as SoundState;
      },
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        preferences: state.preferences,
      }),
    },
  ),
);
