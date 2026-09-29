'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { EMPTY_LIST } from '@/stores/session-filter-store';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';
import { registerPersistedStore, resetPersistedStore } from '@/stores/persisted-store-registry';

/**
 * Which rows of the session tree are open, per project: a parent session id
 * (its spawned children are shown) or a section id (`section:shared`,
 * `section:automated`). Everything is closed until opened, and an opened row
 * stays open across reloads.
 */
const STORAGE_KEY = 'kortix.project-session-expanded';

/** Keeps the newest ids per project so the map cannot grow without bound. */
const MAX_IDS_PER_PROJECT = 200;
const MAX_PROJECTS = 24;

interface State {
  expandedByProject: Record<string, string[]>;
  setExpanded: (projectId: string, id: string, open: boolean) => void;
  toggleExpanded: (projectId: string, id: string) => void;
}

export const selectExpandedIds =
  (projectId: string) =>
  (s: State): readonly string[] =>
    s.expandedByProject[projectId] ?? EMPTY_LIST;

export const useSessionExpandedStore = create<State>()(
  persist(
    (set, get) => ({
      expandedByProject: {},
      setExpanded: (projectId, id, open) => {
        const current = get().expandedByProject[projectId] ?? [];
        if (current.includes(id) === open) return;
        const next = open ? [...current, id].slice(-MAX_IDS_PER_PROJECT) : current.filter((x) => x !== id);
        const map = { ...get().expandedByProject, [projectId]: next };
        const keys = Object.keys(map);
        set({
          expandedByProject:
            keys.length > MAX_PROJECTS
              ? Object.fromEntries(keys.slice(-MAX_PROJECTS).map((k) => [k, map[k]]))
              : map,
        });
      },
      toggleExpanded: (projectId, id) => {
        const open = (get().expandedByProject[projectId] ?? []).includes(id);
        get().setExpanded(projectId, id, !open);
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({ expandedByProject: state.expandedByProject }) as State,
    },
  ),
);

registerPersistedStore(STORAGE_KEY, () => resetPersistedStore(useSessionExpandedStore));
