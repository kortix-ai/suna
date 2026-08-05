'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type {
  SessionFilterValue,
  SessionSourceFilter,
  SessionStatusFilter,
  SessionStatusFilterValue,
} from '@/components/projects/session-label';
import type {
  SessionGroupMode,
  SessionOrderMode,
} from '@/features/workspace/project-sidebar/session-grouping';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * Per-project session-list VIEW state — grouping, ordering, the two filter
 * facets, and section visibility/collapse.
 *
 * Held in a module-level, persisted store so the chosen view survives the
 * project shell remounting on navigation — opening a session, ⌘J, switching
 * sessions. Local component state used to reset back to defaults on every
 * such remount.
 */

const STORAGE_KEY = 'kortix.project-session-view';

/** Soft cap so the per-project map can't grow unbounded; keeps the last N. */
const MAX_TRACKED_PROJECTS = 24;

function pruneProjects<V>(map: Record<string, V>): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_PROJECTS) return map;
  return Object.fromEntries(keys.slice(-MAX_TRACKED_PROJECTS).map((k) => [k, map[k]]));
}

function toggleValue<V>(list: readonly V[], value: V): V[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

interface State {
  /** @deprecated superseded by the source/status facets below; kept until
   *  project-sidebar.tsx / project-session-list.tsx stop importing it. */
  filterByProject: Record<string, SessionFilterValue>;
  /** @deprecated superseded by statusFiltersByProject; kept for the same
   *  reason as filterByProject. */
  statusByProject: Record<string, SessionStatusFilterValue>;

  groupByProject: Record<string, SessionGroupMode>;
  orderByProject: Record<string, SessionOrderMode>;
  statusFiltersByProject: Record<string, SessionStatusFilter[]>;
  sourceFiltersByProject: Record<string, SessionSourceFilter[]>;
  hiddenSectionsByProject: Record<string, string[]>;
  collapsedSectionsByProject: Record<string, string[]>;
}

interface Actions {
  /** @deprecated superseded by the source/status facets below. */
  setFilter: (projectId: string, filter: SessionFilterValue) => void;
  /** @deprecated superseded by toggleStatusFilter. */
  setStatusFilter: (projectId: string, status: SessionStatusFilterValue) => void;

  setGroupMode: (projectId: string, mode: SessionGroupMode) => void;
  setOrderMode: (projectId: string, order: SessionOrderMode) => void;
  toggleStatusFilter: (projectId: string, value: SessionStatusFilter) => void;
  toggleSourceFilter: (projectId: string, value: SessionSourceFilter) => void;
  resetFilters: (projectId: string) => void;
  toggleSectionHidden: (projectId: string, sectionId: string) => void;
  toggleSectionCollapsed: (projectId: string, sectionId: string) => void;
  collapseAllSections: (projectId: string, sectionIds: readonly string[]) => void;
}

export const useSessionFilterStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      filterByProject: {},
      setFilter: (projectId, filter) => {
        if ((get().filterByProject[projectId] ?? 'all') === filter) return;
        set({ filterByProject: { ...get().filterByProject, [projectId]: filter } });
      },
      statusByProject: {},
      setStatusFilter: (projectId, status) => {
        if ((get().statusByProject[projectId] ?? 'all') === status) return;
        set({ statusByProject: { ...get().statusByProject, [projectId]: status } });
      },

      groupByProject: {},
      setGroupMode: (projectId, mode) => {
        if ((get().groupByProject[projectId] ?? 'status') === mode) return;
        set({ groupByProject: { ...get().groupByProject, [projectId]: mode } });
      },

      orderByProject: {},
      setOrderMode: (projectId, order) => {
        if ((get().orderByProject[projectId] ?? 'activity') === order) return;
        set({ orderByProject: { ...get().orderByProject, [projectId]: order } });
      },

      statusFiltersByProject: {},
      toggleStatusFilter: (projectId, value) => {
        const current = get().statusFiltersByProject[projectId] ?? [];
        set({
          statusFiltersByProject: {
            ...get().statusFiltersByProject,
            [projectId]: toggleValue(current, value),
          },
        });
      },

      sourceFiltersByProject: {},
      toggleSourceFilter: (projectId, value) => {
        const current = get().sourceFiltersByProject[projectId] ?? [];
        set({
          sourceFiltersByProject: {
            ...get().sourceFiltersByProject,
            [projectId]: toggleValue(current, value),
          },
        });
      },

      resetFilters: (projectId) => {
        set({
          statusFiltersByProject: { ...get().statusFiltersByProject, [projectId]: [] },
          sourceFiltersByProject: { ...get().sourceFiltersByProject, [projectId]: [] },
        });
      },

      hiddenSectionsByProject: {},
      toggleSectionHidden: (projectId, sectionId) => {
        const current = get().hiddenSectionsByProject[projectId] ?? [];
        set({
          hiddenSectionsByProject: {
            ...get().hiddenSectionsByProject,
            [projectId]: toggleValue(current, sectionId),
          },
        });
      },

      collapsedSectionsByProject: {},
      toggleSectionCollapsed: (projectId, sectionId) => {
        const current = get().collapsedSectionsByProject[projectId] ?? [];
        set({
          collapsedSectionsByProject: {
            ...get().collapsedSectionsByProject,
            [projectId]: toggleValue(current, sectionId),
          },
        });
      },
      collapseAllSections: (projectId, sectionIds) => {
        set({
          collapsedSectionsByProject: {
            ...get().collapsedSectionsByProject,
            [projectId]: [...sectionIds],
          },
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        filterByProject: pruneProjects(state.filterByProject),
        statusByProject: pruneProjects(state.statusByProject),
        groupByProject: pruneProjects(state.groupByProject),
        orderByProject: pruneProjects(state.orderByProject),
        statusFiltersByProject: pruneProjects(state.statusFiltersByProject),
        sourceFiltersByProject: pruneProjects(state.sourceFiltersByProject),
        hiddenSectionsByProject: pruneProjects(state.hiddenSectionsByProject),
        collapsedSectionsByProject: pruneProjects(state.collapsedSectionsByProject),
      }),
    },
  ),
);
