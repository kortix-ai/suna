'use client';

import { createSafeJSONStorage } from '@/lib/storage/managed-storage';
import { DEFAULT_WALLPAPER_ID } from '@/lib/wallpapers';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ============================================================================
// Types
// ============================================================================

/** Which modifier key is used for tab switching (Cmd+1..9 or Ctrl+1..9) */
export type TabSwitchModifier = 'meta' | 'ctrl';

/** Session panel presentation: 'easy' = plain-language cards, 'advanced' = the tool stepper */
export type PanelMode = 'easy' | 'advanced';

/**
 * How much live activity the session chat shows while Kortix works.
 * 'normal' auto-expands the activity burst — steps and streaming thinking
 * text appear as they happen. 'minimal' keeps the burst collapsed to its
 * one-line summary until the user opens it.
 */
export type ConversationDensity = 'normal' | 'minimal';

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
  /** Session action panel mode — defaults to 'easy' for all users */
  panelMode: PanelMode;
  /**
   * Conversation density of the session chat — defaults to 'normal'.
   * Legacy persisted preferences predate this key, so read sites must use
   * `?? 'normal'` (same rule as `panelMode`).
   */
  conversationDensity: ConversationDensity;
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
  patchPreferences: (partial: Partial<UserPreferences>) => void;

  /** Update keyboard shortcut preferences (partial merge) */
  setKeyboardPreferences: (prefs: Partial<KeyboardShortcutPreferences>) => void;

  /** Set the active Kortix theme by ID */
  setThemeId: (themeId: string) => void;

  /** Set the active desktop wallpaper by ID */
  setWallpaperId: (wallpaperId: string) => void;

  /** Flip between easy and advanced */
  togglePanelMode: () => void;

  /** Set the conversation density */
  setConversationDensity: (density: ConversationDensity) => void;

  /** Get the label for the current tab switch modifier (e.g. "Cmd" or "Ctrl") */
  getModifierLabel: () => string;
}

const DEFAULT_PREFERENCES: UserPreferences = {
  keyboard: getDefaultKeyboardPreferences(),
  themeId: 'graphite',
  wallpaperId: DEFAULT_WALLPAPER_ID,
  panelMode: 'easy',
  conversationDensity: 'normal',
};

export const useUserPreferencesStore = create<UserPreferencesState>()(
  persist(
    (set, get) => ({
      preferences: DEFAULT_PREFERENCES,

      patchPreferences: (partial) => set({ preferences: { ...get().preferences, ...partial } }),

      setKeyboardPreferences: (prefs) => get().patchPreferences({ keyboard: { ...get().preferences.keyboard, ...prefs } }),

      setThemeId: (themeId) => get().patchPreferences({ themeId }),

      setWallpaperId: (wallpaperId) => get().patchPreferences({ wallpaperId }),

      togglePanelMode: () => {
        const current = get().preferences;
        // Legacy users' persisted preferences predate this key entirely, so
        // `current.panelMode` can be `undefined` at runtime even though the
        // type says it can't — treat that exactly like 'easy' (every read
        // site in the app already does via `?? 'easy'`), or the toggle
        // silently writes 'easy' back and the Advanced affordance does nothing.
        const effective = current.panelMode ?? 'easy';
        get().patchPreferences({ panelMode: effective === 'easy' ? 'advanced' : 'easy' });
      },

      setConversationDensity: (density) => get().patchPreferences({ conversationDensity: density }),

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
    },
  ),
);
