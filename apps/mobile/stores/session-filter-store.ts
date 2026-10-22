/**
 * The Sessions page's search, status and starter filter, and its Archived
 * view, per project (KRTX-250, KRTX-2418).
 *
 * Opening a session replaces the Sessions page with the view route, which
 * unmounts it; component state would reset the filter every time the user
 * came back. This store keeps it for the app's lifetime, keyed by project id.
 * In memory only: a relaunch starts unfiltered. Sign-out resets it
 * (`resetUserStores` in hooks/useAuth.ts): a query is the user's text.
 */

import { create } from 'zustand';

import type { SessionStatusFilter } from '@/lib/session/session-list';
import type { SessionScope } from '@/lib/session/session-tree';

export interface SessionFilter {
  query: string;
  /** Picked statuses, in pick order. Empty = every status. */
  statuses: SessionStatusFilter[];
  /** Who started the session: the All / Mine / Shared / Automated chip (KRTX-639). */
  scope: SessionScope;
  /** The viewer's archived sessions instead of the list (KRTX-2418). */
  archived: boolean;
}

export const EMPTY_SESSION_FILTER: SessionFilter = { query: '', statuses: [], scope: 'all', archived: false };

interface SessionFilterState {
  /** project id → filter. A project with no entry is unfiltered. */
  byProject: Record<string, SessionFilter>;
  setQuery: (projectId: string, query: string) => void;
  toggleStatus: (projectId: string, status: SessionStatusFilter) => void;
  setScope: (projectId: string, scope: SessionScope) => void;
  /** The Filter sheet's Archived row: the archived sessions, or the list again. */
  toggleArchived: (projectId: string) => void;
  /** The page's one Reset: search, statuses, scope and the Archived view. */
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
  setScope: (projectId, scope) =>
    set((state) => {
      const current = state.byProject[projectId] ?? EMPTY_SESSION_FILTER;
      if (current.scope === scope) return state;
      return { byProject: { ...state.byProject, [projectId]: { ...current, scope } } };
    }),
  toggleArchived: (projectId) =>
    set((state) => {
      const current = state.byProject[projectId] ?? EMPTY_SESSION_FILTER;
      return { byProject: { ...state.byProject, [projectId]: { ...current, archived: !current.archived } } };
    }),
  resetProject: (projectId) =>
    set((state) => {
      if (!(projectId in state.byProject)) return state;
      const { [projectId]: _removed, ...rest } = state.byProject;
      return { byProject: rest };
    }),
  reset: () => set({ byProject: {} }),
}));
