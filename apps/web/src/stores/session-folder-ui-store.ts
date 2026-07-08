'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { AutoFolderKind } from '@/components/projects/session-folder-grouping';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * FOLDERS sidebar preferences, persisted per project.
 *
 * The folders section shows user-created folders only by default; the virtual
 * source folders (Slack / Email / Scheduled / Webhooks…) are opt-in via the
 * section's ⋯ menu — mirroring how the SESSIONS filter works.
 */

const STORAGE_KEY = 'kortix.project-folder-prefs';

const MAX_TRACKED_PROJECTS = 24;

function pruneProjects<V>(map: Record<string, V>): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_PROJECTS) return map;
  return Object.fromEntries(keys.slice(-MAX_TRACKED_PROJECTS).map((k) => [k, map[k]]));
}

interface State {
  showAutoByProject: Record<string, Partial<Record<AutoFolderKind, boolean>>>;
}

interface Actions {
  setShowAuto: (projectId: string, kind: AutoFolderKind, show: boolean) => void;
}

export const useSessionFolderUiStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      showAutoByProject: {},
      setShowAuto: (projectId, kind, show) => {
        const current = get().showAutoByProject[projectId] ?? {};
        if ((current[kind] ?? false) === show) return;
        set({
          showAutoByProject: {
            ...get().showAutoByProject,
            [projectId]: { ...current, [kind]: show },
          },
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({ showAutoByProject: pruneProjects(state.showAutoByProject) }),
    },
  ),
);
