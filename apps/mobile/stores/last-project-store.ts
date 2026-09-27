/**
 * The project each user had open last, so the app reopens it (app/index.tsx).
 *
 * Keyed by user id: a phone outlives a session, and the next person to sign in
 * must not land in the previous person's project (web keeps `<userId>:<projectId>`
 * in its last-project cookie for the same reason). The value is untrusted: the
 * start screen opens it at once, and the server's lists confirm it in the
 * background (`checkLastProject`, lib/projects/landing.ts). A project no
 * account lists any more is forgotten.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface LastProjectState {
  /** user id → project id */
  byUser: Record<string, string>;
  remember: (userId: string, projectId: string) => void;
  /** The remembered project is gone: the next start resolves one again. */
  forget: (userId: string) => void;
  /** Sign-out: forget every remembered project. */
  reset: () => void;
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
      forget: (userId) =>
        set((state) => {
          if (!(userId in state.byUser)) return state;
          const { [userId]: _forgotten, ...byUser } = state.byUser;
          return { byUser };
        }),
      reset: () => set({ byUser: {} }),
    }),
    {
      name: 'kortix.lastProject',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
