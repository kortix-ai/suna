/**
 * This phone's notification switches (Settings → Notifications), posted with
 * its push token (lib/notifications/registration.ts): the off switch, one
 * switch per session kind, and the sound.
 *
 * A project with the `notification_center` flag on (KRTX-1742) also reads the
 * user's record on the server: a session kind pushes there only when the
 * record AND this phone allow it. `legacyKindsMigrated` turns true once the
 * kinds this phone turned off are in that record (`carryOverLegacyKinds`).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface NotificationPreferences {
  enabled: boolean;
  onCompletion: boolean;
  onError: boolean;
  onQuestion: boolean;
  onPermission: boolean;
  playSound: boolean;
}

interface NotificationState {
  preferences: NotificationPreferences;
  /** The kinds this phone turned off are in the user's record. Never resets. */
  legacyKindsMigrated: boolean;
  setPreference: <K extends keyof NotificationPreferences>(
    key: K,
    value: NotificationPreferences[K],
  ) => void;
  toggleEnabled: () => void;
  markLegacyKindsMigrated: () => void;
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: true,
  onCompletion: true,
  onError: true,
  onQuestion: true,
  onPermission: true,
  playSound: true,
};

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set) => ({
      preferences: DEFAULT_PREFERENCES,
      legacyKindsMigrated: false,

      setPreference: (key, value) => {
        set((state) => ({
          preferences: { ...state.preferences, [key]: value },
        }));
      },

      toggleEnabled: () => {
        set((state) => ({
          preferences: { ...state.preferences, enabled: !state.preferences.enabled },
        }));
      },

      markLegacyKindsMigrated: () => set({ legacyKindsMigrated: true }),
    }),
    {
      name: '@notification_preferences',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        preferences: state.preferences,
        legacyKindsMigrated: state.legacyKindsMigrated,
      }),
      // An install that ran the first KRTX-1742 build stored no per-kind
      // switches: the missing ones load as on.
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<NotificationState>;
        return {
          ...current,
          ...stored,
          preferences: { ...current.preferences, ...stored.preferences },
        };
      },
    },
  ),
);
