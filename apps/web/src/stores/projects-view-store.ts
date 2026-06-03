import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * How the Projects page groups its grid:
 *  - 'all'     → every account the user belongs to, grouped under account headers.
 *  - 'account' → just the currently-selected account (the classic single view).
 *
 * This is purely a *view* preference for the projects grid — it deliberately
 * does NOT touch the active account (current-account-store). Account-scoped
 * surfaces (billing, settings, members) always read a concrete account from the
 * switcher, so they're unaffected by an "all accounts" browse. Defaults to 'all'
 * so a freshly-invited member sees the project they joined without first having
 * to discover and switch accounts.
 */
export type ProjectsViewMode = 'account' | 'all';

interface ProjectsViewState {
  viewMode: ProjectsViewMode;
  setViewMode: (mode: ProjectsViewMode) => void;
}

export const useProjectsViewStore = create<ProjectsViewState>()(
  persist(
    (set) => ({
      viewMode: 'all',
      setViewMode: (mode) => set({ viewMode: mode }),
    }),
    {
      name: 'kortix.projectsView',
      storage: createSafeJSONStorage(),
      version: 1,
    },
  ),
);
