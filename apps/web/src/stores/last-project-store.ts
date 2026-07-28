import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { clearLastProjectCookie, writeLastProjectCookie } from '@/lib/home/last-project-cookie';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * The last project the user opened, so `/` can drop them straight back into
 * their work instead of a grid of cards.
 *
 * Keyed by account: switching orgs must land on THAT org's last project, not
 * bounce you back into the one you just left.
 *
 * Mirrors to a cookie on every write — middleware and server components cannot
 * read localStorage, and `/` has to decide where to send someone before any
 * client code runs.
 */
interface LastProjectState {
  lastProjectByAccount: Record<string, string>;
  setLastProject: (accountId: string | null | undefined, projectId: string) => void;
  forgetProject: (projectId: string) => void;
  clear: () => void;
}

export const useLastProjectStore = create<LastProjectState>()(
  persist(
    (set, get) => ({
      lastProjectByAccount: {},

      setLastProject: (accountId, projectId) => {
        if (!projectId) return;
        // The cookie is the one `/` actually reads, so write it even when the
        // account is not resolved yet.
        writeLastProjectCookie(projectId);
        if (!accountId) return;
        if (get().lastProjectByAccount[accountId] === projectId) return;
        set((state) => ({
          lastProjectByAccount: { ...state.lastProjectByAccount, [accountId]: projectId },
        }));
      },

      /** Called when a project 403s or 404s — stop sending the user there. */
      forgetProject: (projectId) => {
        clearLastProjectCookie();
        set((state) => {
          const next: Record<string, string> = {};
          for (const [accountId, id] of Object.entries(state.lastProjectByAccount)) {
            if (id !== projectId) next[accountId] = id;
          }
          return { lastProjectByAccount: next };
        });
      },

      clear: () => {
        clearLastProjectCookie();
        set({ lastProjectByAccount: {} });
      },
    }),
    {
      name: 'kortix.lastProject',
      storage: createSafeJSONStorage(),
      version: 1,
    },
  ),
);
