'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { SessionFilterValue } from '@/components/projects/session-label';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * Per-project session-list filter (All / My Chats / Slack / Email / …).
 *
 * Held in a module-level, persisted store so the chosen filter survives the
 * project shell remounting on navigation — opening a session, ⌘J, switching
 * sessions. Local component state used to reset back to "all" on every such
 * remount.
 */

const STORAGE_KEY = 'kortix.project-session-filter';

/** Soft cap so the per-project map can't grow unbounded; keeps the last N. */
const MAX_TRACKED_PROJECTS = 24;

function pruneProjects<V>(map: Record<string, V>): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_PROJECTS) return map;
  return Object.fromEntries(keys.slice(-MAX_TRACKED_PROJECTS).map((k) => [k, map[k]]));
}

interface State {
  filterByProject: Record<string, SessionFilterValue>;
}

interface Actions {
  setFilter: (projectId: string, filter: SessionFilterValue) => void;
}

export const useSessionFilterStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      filterByProject: {},
      setFilter: (projectId, filter) => {
        if ((get().filterByProject[projectId] ?? 'all') === filter) return;
        set({ filterByProject: { ...get().filterByProject, [projectId]: filter } });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({ filterByProject: pruneProjects(state.filterByProject) }),
    },
  ),
);
