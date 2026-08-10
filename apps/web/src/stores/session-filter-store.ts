'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { SessionSourceFilter, SessionStatusFilter } from '@/components/workspaces/session-label';
import {
  DEFAULT_SESSION_GROUP_MODE,
  type SessionGroupMode,
  type SessionOrderMode,
} from '@/features/workspace/workspace-sidebar/session-grouping';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * Per-workspace session-list VIEW state — grouping, ordering, the two filter
 * facets, and section visibility/collapse.
 *
 * Held in a module-level, persisted store so the chosen view survives the
 * workspace shell remounting on navigation — opening a session, ⌘J, switching
 * sessions. Local component state used to reset back to defaults on every
 * such remount.
 */

const STORAGE_KEY = 'kortix.workspace-session-view';

/**
 * The fallback every list-valued selector must use — never a bare `[]`.
 *
 * zustand v5 reads through `useSyncExternalStore`, which compares snapshots
 * with `Object.is`. A selector written `s.statusFiltersByWorkspace[id] ?? []`
 * allocates a NEW array on every read, so the snapshot never equals the
 * previous one and React re-renders forever ("Maximum update depth exceeded").
 * One frozen module-level reference makes the comparison stable.
 *
 * `readonly never[]` is assignable to any `readonly T[]`, so a single constant
 * serves every list in this store.
 */
export const EMPTY_LIST: readonly never[] = Object.freeze([]);

/** Soft cap so the per-workspace map cannot grow unbounded; keeps the last N. */
const MAX_TRACKED_WORKSPACES = 24;

function pruneWorkspaces<V>(map: Record<string, V>): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_WORKSPACES) return map;
  return Object.fromEntries(keys.slice(-MAX_TRACKED_WORKSPACES).map((k) => [k, map[k]]));
}

function toggleValue<V>(list: readonly V[], value: V): V[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

interface State {
  groupByWorkspace: Record<string, SessionGroupMode>;
  orderByWorkspace: Record<string, SessionOrderMode>;
  statusFiltersByWorkspace: Record<string, SessionStatusFilter[]>;
  sourceFiltersByWorkspace: Record<string, SessionSourceFilter[]>;
  hiddenSectionsByWorkspace: Record<string, string[]>;
  collapsedSectionsByWorkspace: Record<string, string[]>;
}

interface Actions {
  setGroupMode: (workspaceId: string, mode: SessionGroupMode) => void;
  setOrderMode: (workspaceId: string, order: SessionOrderMode) => void;
  toggleStatusFilter: (workspaceId: string, value: SessionStatusFilter) => void;
  toggleSourceFilter: (workspaceId: string, value: SessionSourceFilter) => void;
  resetFilters: (workspaceId: string) => void;
  toggleSectionHidden: (workspaceId: string, sectionId: string) => void;
  toggleSectionCollapsed: (workspaceId: string, sectionId: string) => void;
  collapseAllSections: (workspaceId: string, sectionIds: readonly string[]) => void;
}

export const useSessionFilterStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      groupByWorkspace: {},
      setGroupMode: (workspaceId, mode) => {
        if ((get().groupByWorkspace[workspaceId] ?? DEFAULT_SESSION_GROUP_MODE) === mode) return;
        set({ groupByWorkspace: { ...get().groupByWorkspace, [workspaceId]: mode } });
      },

      orderByWorkspace: {},
      setOrderMode: (workspaceId, order) => {
        if ((get().orderByWorkspace[workspaceId] ?? 'activity') === order) return;
        set({ orderByWorkspace: { ...get().orderByWorkspace, [workspaceId]: order } });
      },

      statusFiltersByWorkspace: {},
      toggleStatusFilter: (workspaceId, value) => {
        const current = get().statusFiltersByWorkspace[workspaceId] ?? [];
        set({
          statusFiltersByWorkspace: {
            ...get().statusFiltersByWorkspace,
            [workspaceId]: toggleValue(current, value),
          },
        });
      },

      sourceFiltersByWorkspace: {},
      toggleSourceFilter: (workspaceId, value) => {
        const current = get().sourceFiltersByWorkspace[workspaceId] ?? [];
        set({
          sourceFiltersByWorkspace: {
            ...get().sourceFiltersByWorkspace,
            [workspaceId]: toggleValue(current, value),
          },
        });
      },

      resetFilters: (workspaceId) => {
        set({
          statusFiltersByWorkspace: { ...get().statusFiltersByWorkspace, [workspaceId]: [] },
          sourceFiltersByWorkspace: { ...get().sourceFiltersByWorkspace, [workspaceId]: [] },
        });
      },

      hiddenSectionsByWorkspace: {},
      toggleSectionHidden: (workspaceId, sectionId) => {
        const current = get().hiddenSectionsByWorkspace[workspaceId] ?? [];
        set({
          hiddenSectionsByWorkspace: {
            ...get().hiddenSectionsByWorkspace,
            [workspaceId]: toggleValue(current, sectionId),
          },
        });
      },

      collapsedSectionsByWorkspace: {},
      toggleSectionCollapsed: (workspaceId, sectionId) => {
        const current = get().collapsedSectionsByWorkspace[workspaceId] ?? [];
        set({
          collapsedSectionsByWorkspace: {
            ...get().collapsedSectionsByWorkspace,
            [workspaceId]: toggleValue(current, sectionId),
          },
        });
      },
      collapseAllSections: (workspaceId, sectionIds) => {
        set({
          collapsedSectionsByWorkspace: {
            ...get().collapsedSectionsByWorkspace,
            [workspaceId]: [...sectionIds],
          },
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      version: 1,
      migrate: (persisted) => {
        const legacy = persisted as Partial<State> & {
          groupByProject?: Record<string, SessionGroupMode>;
          orderByProject?: Record<string, SessionOrderMode>;
          statusFiltersByProject?: Record<string, SessionStatusFilter[]>;
          sourceFiltersByProject?: Record<string, SessionSourceFilter[]>;
          hiddenSectionsByProject?: Record<string, string[]>;
          collapsedSectionsByProject?: Record<string, string[]>;
        };
        return {
          ...legacy,
          groupByWorkspace: legacy.groupByWorkspace ?? legacy.groupByProject ?? {},
          orderByWorkspace: legacy.orderByWorkspace ?? legacy.orderByProject ?? {},
          statusFiltersByWorkspace:
            legacy.statusFiltersByWorkspace ?? legacy.statusFiltersByProject ?? {},
          sourceFiltersByWorkspace:
            legacy.sourceFiltersByWorkspace ?? legacy.sourceFiltersByProject ?? {},
          hiddenSectionsByWorkspace:
            legacy.hiddenSectionsByWorkspace ?? legacy.hiddenSectionsByProject ?? {},
          collapsedSectionsByWorkspace:
            legacy.collapsedSectionsByWorkspace ?? legacy.collapsedSectionsByProject ?? {},
        } as State & Actions;
      },
      partialize: (state) => ({
        groupByWorkspace: pruneWorkspaces(state.groupByWorkspace),
        orderByWorkspace: pruneWorkspaces(state.orderByWorkspace),
        statusFiltersByWorkspace: pruneWorkspaces(state.statusFiltersByWorkspace),
        sourceFiltersByWorkspace: pruneWorkspaces(state.sourceFiltersByWorkspace),
        hiddenSectionsByWorkspace: pruneWorkspaces(state.hiddenSectionsByWorkspace),
        collapsedSectionsByWorkspace: pruneWorkspaces(state.collapsedSectionsByWorkspace),
      }),
    },
  ),
);
