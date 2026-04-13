'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_WALLPAPER_ID } from '@/lib/wallpapers';

// ============================================================================
// Types
// ============================================================================

/** Which modifier key is used for tab switching (Cmd+1..9 or Ctrl+1..9) */
export type TabSwitchModifier = 'meta' | 'ctrl';

export interface KeyboardShortcutPreferences {
  /** Modifier used for tab switching shortcuts (1-9) — default: 'meta' on macOS, 'ctrl' elsewhere */
  tabSwitchModifier: TabSwitchModifier;
  /** Modifier for close-tab shortcut (W) — follows tabSwitchModifier */
  closeTabModifier: TabSwitchModifier;
}

export interface UserPreferences {
  keyboard: KeyboardShortcutPreferences;
  /** Selected Kortix theme ID (e.g. 'default', 'ember', 'aurora') */
  themeId: string;
  /** Selected desktop wallpaper ID */
  wallpaperId: string;
}

// ============================================================================
// Helpers
// ============================================================================

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

function getDefaultKeyboardPreferences(): KeyboardShortcutPreferences {
  return {
    tabSwitchModifier: 'ctrl',
    closeTabModifier: 'ctrl',
  };
}

// ============================================================================
// Store
// ============================================================================

interface UserPreferencesState {
  preferences: UserPreferences;

  /** Update keyboard shortcut preferences (partial merge) */
  setKeyboardPreferences: (prefs: Partial<KeyboardShortcutPreferences>) => void;

  /** Set the active Kortix theme by ID */
  setThemeId: (themeId: string) => void;

  /** Set the active desktop wallpaper by ID */
  setWallpaperId: (wallpaperId: string) => void;

  /** Reset all preferences to defaults */
  resetPreferences: () => void;

  /** Get the label for the current tab switch modifier (e.g. "Cmd" or "Ctrl") */
  getModifierLabel: () => string;
}

export const useUserPreferencesStore = create<UserPreferencesState>()(
  persist(
    (set, get) => ({
      preferences: {
        keyboard: getDefaultKeyboardPreferences(),
        themeId: 'graphite',
        wallpaperId: DEFAULT_WALLPAPER_ID,
      },

      setKeyboardPreferences: (prefs) => {
        const current = get().preferences;
        set({
          preferences: {
            ...current,
            keyboard: { ...current.keyboard, ...prefs },
          },
        });
      },

      setThemeId: (themeId) => {
        const current = get().preferences;
        set({
          preferences: {
            ...current,
            themeId,
          },
        });
      },

      setWallpaperId: (wallpaperId) => {
        const current = get().preferences;
        set({
          preferences: {
            ...current,
            wallpaperId,
          },
        });
      },

      resetPreferences: () => {
        set({
          preferences: {
            keyboard: getDefaultKeyboardPreferences(),
            themeId: 'graphite',
            wallpaperId: DEFAULT_WALLPAPER_ID,
          },
        });
      },

      getModifierLabel: () => {
        const mod = get().preferences.keyboard.tabSwitchModifier;
        return mod === 'meta' ? (isMac ? 'Cmd' : 'Win') : 'Ctrl';
      },
    }),
    {
      name: 'kortix-user-preferences',
      partialize: (state) => ({
        preferences: state.preferences,
      }),
    }
  )
);
