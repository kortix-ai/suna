/**
 * The Sessions page's search and status filter, per project (KRTX-250).
 *
 * Opening a session replaces the Sessions page with the view route, which
 * unmounts it; component state would reset the filter every time the user
 * came back. This store keeps it for the app's lifetime, keyed by project id.
 * In memory only: a relaunch starts unfiltered. Sign-out resets it
 * (`resetUserStores` in hooks/useAuth.ts): a query is the user's text.
 */

import { create } from 'zustand';

import type { SessionStatusFilter } from '@/lib/session/session-list';

export interface SessionFilter {
  query: string;
  /** Picked statuses, in pick order. Empty = every status. */
  statuses: SessionStatusFilter[];
}

export const EMPTY_SESSION_FILTER: SessionFilter = { query: '', statuses: [] };

interface SessionFilterState {
  /** project id → filter. A project with no entry is unfiltered. */
  byProject: Record<string, SessionFilter>;
  setQuery: (projectId: string, query: string) => void;
  toggleStatus: (projectId: string, status: SessionStatusFilter) => void;
  /** The page's one Reset: search and statuses both. */
  resetProject: (projectId: string) => void;
  /** Sign-out: forget every project's filter. */
  reset: () => void;
}

export const useSessionFilterStore = create<SessionFilterState>()((set) => ({
  byProject: {},
  setQuery: (projectId, query) =>
    set((state) => {
      const current = state.byProject[projectId] ?? EMPTY_SESSION_FILTER;
      if (current.query === query) return state;
      return { byProject: { ...state.byProject, [projectId]: { ...current, query } } };
    }),
  toggleStatus: (projectId, status) =>
    set((state) => {
      const current = state.byProject[projectId] ?? EMPTY_SESSION_FILTER;
      const statuses = current.statuses.includes(status)
        ? current.statuses.filter((picked) => picked !== status)
        : [...current.statuses, status];
      return { byProject: { ...state.byProject, [projectId]: { ...current, statuses } } };
    }),
  resetProject: (projectId) =>
    set((state) => {
      if (!(projectId in state.byProject)) return state;
      const { [projectId]: _removed, ...rest } = state.byProject;
      return { byProject: rest };
    }),
  reset: () => set({ byProject: {} }),
}));
