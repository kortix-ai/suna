/**
 * Push registration state for this device (components/notifications/
 * PushNotificationsBridge.tsx, lib/notifications/registration.ts).
 *
 * Persisted (device facts, kept across sign-out, lib/auth/sign-out-keys.ts):
 * - `token`: the Expo push token last registered from this device.
 * - `permissionAsked`: the OS permission prompt was shown once already.
 *
 * In memory only:
 * - `viewingSessionId`: the project session on screen, for the foreground rule.
 * - `pendingOpen`: a tapped notification's session, until ProjectScreen opens it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export const PUSH_STORE_KEY = '@push_registration';

export interface PendingOpen {
  projectId: string;
  sessionId: string;
  /** The bridge already moved to the project route for this request. */
  navigated: boolean;
}

interface PushState {
  token: string | null;
  permissionAsked: boolean;
  viewingSessionId: string | null;
  pendingOpen: PendingOpen | null;
  setToken: (token: string | null) => void;
  markPermissionAsked: () => void;
  setViewingSessionId: (sessionId: string | null) => void;
  requestOpen: (projectId: string, sessionId: string) => void;
  markOpenNavigated: () => void;
  /** Takes the pending open for `projectId`, or null when none is for it. */
  takeOpen: (projectId: string) => PendingOpen | null;
}

export const usePushStore = create<PushState>()(
  persist(
    (set, get) => ({
      token: null,
      permissionAsked: false,
      viewingSessionId: null,
      pendingOpen: null,
      setToken: (token) => set({ token }),
      markPermissionAsked: () => set({ permissionAsked: true }),
      setViewingSessionId: (viewingSessionId) =>
        set((state) => (state.viewingSessionId === viewingSessionId ? state : { viewingSessionId })),
      requestOpen: (projectId, sessionId) => set({ pendingOpen: { projectId, sessionId, navigated: false } }),
      markOpenNavigated: () =>
        set((state) => (state.pendingOpen ? { pendingOpen: { ...state.pendingOpen, navigated: true } } : state)),
      takeOpen: (projectId) => {
        const pending = get().pendingOpen;
        if (!pending || pending.projectId !== projectId) return null;
        set({ pendingOpen: null });
        return pending;
      },
    }),
    {
      name: PUSH_STORE_KEY,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ token: state.token, permissionAsked: state.permissionAsked }),
    }
  )
);
