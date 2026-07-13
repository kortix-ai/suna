'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';
import { DEFAULT_WALLPAPER_ID } from '@/lib/wallpapers';

// ============================================================================
// Types
// ============================================================================

/** Which modifier key is used for tab switching (Cmd+1..9 or Ctrl+1..9) */
export type TabSwitchModifier = 'meta' | 'ctrl';

/** Session panel presentation: 'easy' = plain-language cards, 'advanced' = the tool stepper */
export type PanelMode = 'easy' | 'advanced';

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
  /** When true, the tab selector bar is hidden and content extends to the top */
  disableTabSelector: boolean;
  /** Session action panel mode — defaults to 'easy' for all users */
  panelMode: PanelMode;
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

  /** Toggle the tab selector bar on/off */
  setDisableTabSelector: (disabled: boolean) => void;

  /** Set the session panel mode */
  setPanelMode: (mode: PanelMode) => void;

  /** Flip between easy and advanced */
  togglePanelMode: () => void;

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
        disableTabSelector: false,
        panelMode: 'easy',
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

      setDisableTabSelector: (disabled) => {
        const current = get().preferences;
        set({
          preferences: {
            ...current,
            disableTabSelector: disabled,
          },
        });
      },

      setPanelMode: (mode) => {
        const current = get().preferences;
        set({ preferences: { ...current, panelMode: mode } });
      },

      togglePanelMode: () => {
        const current = get().preferences;
        // Legacy users' persisted preferences predate this key entirely, so
        // `current.panelMode` can be `undefined` at runtime even though the
        // type says it can't — treat that exactly like 'easy' (every read
        // site in the app already does via `?? 'easy'`), or the toggle
        // silently writes 'easy' back and the Advanced affordance does nothing.
        const effective = current.panelMode ?? 'easy';
        set({
          preferences: {
            ...current,
            panelMode: effective === 'easy' ? 'advanced' : 'easy',
          },
        });
      },

      resetPreferences: () => {
        set({
          preferences: {
            keyboard: getDefaultKeyboardPreferences(),
            themeId: 'graphite',
            wallpaperId: DEFAULT_WALLPAPER_ID,
            disableTabSelector: false,
            panelMode: 'easy',
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
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        preferences: state.preferences,
      }),
    }
  )
);
