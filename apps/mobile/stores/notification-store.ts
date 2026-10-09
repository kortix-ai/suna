/**
 * This phone's notification switches (Settings → Notifications), posted with
 * its push token (lib/notifications/registration.ts).
 *
 * - `enabled`: this phone's off switch for every push.
 * - `playSound`: the sound of a push on this phone.
 *
 * Which kinds push is the user's record on the server, the same on every
 * device (`useNotificationPreferences`, KRTX-1742). The per-kind switches this
 * store held before are no longer read; a persisted copy keeps them, unused.
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
  setPreference: <K extends keyof DeviceNotificationPreferences>(
    key: K,
    value: DeviceNotificationPreferences[K],
  ) => void;
  toggleEnabled: () => void;
}

const DEFAULT_PREFERENCES: DeviceNotificationPreferences = {
  enabled: true,
  playSound: true,
};

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set) => ({
      preferences: DEFAULT_PREFERENCES,

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
    }),
    {
      name: '@notification_preferences',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        preferences: state.preferences,
      }),
    },
  ),
);
