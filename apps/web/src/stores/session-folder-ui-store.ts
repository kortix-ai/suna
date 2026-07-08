'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * Sidebar folder expand/collapse state, persisted per project so folders keep
 * their open state across the project shell remounting on navigation.
 *
 * Keys are `folder_id` for manual folders and the auto-folder kind ('slack',
 * 'email', …) for virtual ones. Folders default to COLLAPSED — silos stay
 * closed until opened; the list auto-expands the folder holding the active
 * session on top of this state.
 */

const STORAGE_KEY = 'kortix.project-session-folders';

const MAX_TRACKED_PROJECTS = 24;

function pruneProjects<V>(map: Record<string, V>): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_PROJECTS) return map;
  return Object.fromEntries(keys.slice(-MAX_TRACKED_PROJECTS).map((k) => [k, map[k]]));
}

interface State {
  expandedByProject: Record<string, Record<string, boolean>>;
}

interface Actions {
  setExpanded: (projectId: string, folderKey: string, expanded: boolean) => void;
}

export const useSessionFolderUiStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      expandedByProject: {},
      setExpanded: (projectId, folderKey, expanded) => {
        const current = get().expandedByProject[projectId] ?? {};
        if ((current[folderKey] ?? false) === expanded) return;
        set({
          expandedByProject: {
            ...get().expandedByProject,
            [projectId]: { ...current, [folderKey]: expanded },
          },
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({ expandedByProject: pruneProjects(state.expandedByProject) }),
    },
  ),
);
