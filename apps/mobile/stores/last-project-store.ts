/**
 * The project each user had open last, so the app reopens it (app/index.tsx).
 *
 * Keyed by user id: a phone outlives a session, and the next person to sign in
 * must not land in the previous person's project (web keeps `<userId>:<projectId>`
 * in its last-project cookie for the same reason). The value is untrusted: the
 * landing resolver (lib/projects/landing.ts) opens it only if the server still
 * lists it for that user.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface LastProjectState {
  /** user id → project id */
  byUser: Record<string, string>;
  remember: (userId: string, projectId: string) => void;
}

export const useLastProjectStore = create<LastProjectState>()(
  persist(
    (set) => ({
      byUser: {},
      remember: (userId, projectId) =>
        set((state) =>
          state.byUser[userId] === projectId
            ? state
            : { byUser: { ...state.byUser, [userId]: projectId } }
        ),
    }),
    {
      name: 'kortix.lastProject',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
