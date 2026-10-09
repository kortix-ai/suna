/**
 * This phone's notification switches (Settings → Notifications), posted with
 * its push token (lib/notifications/registration.ts).
 *
 * - `enabled`: this phone's off switch for every push.
 * - `playSound`: the sound of a push on this phone.
 *
 * Which kinds push is the user's record on the server, the same on every
 * device (`useNotificationPreferences`, KRTX-1742). The per-kind switches this
 * store held before stay in a persisted copy. `legacyKindsMigrated` turns true
 * once the kinds they turned off are in the user's record
 * (lib/notifications/registration.ts); until then the device row keeps them.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface DeviceNotificationPreferences {
  enabled: boolean;
  playSound: boolean;
}

interface NotificationState {
  preferences: DeviceNotificationPreferences;
  /** The stored per-kind switches are in the user's record. Never resets. */
  legacyKindsMigrated: boolean;
  setPreference: <K extends keyof DeviceNotificationPreferences>(
    key: K,
    value: DeviceNotificationPreferences[K],
  ) => void;
  toggleEnabled: () => void;
  markLegacyKindsMigrated: () => void;
}

const DEFAULT_PREFERENCES: DeviceNotificationPreferences = {
  enabled: true,
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
    },
  ),
);
