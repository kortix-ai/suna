'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { AutoFolderKind } from '@/components/projects/session-folder-grouping';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * FOLDERS / SESSIONS sidebar preferences, persisted per project:
 *  - which source folders (Slack / Email / Scheduled / Webhooks…) are shown —
 *    opt-in via the FOLDERS ⋯ menu, mirroring the SESSIONS filter;
 *  - whether each sidebar CATEGORY (folders, sessions) is expanded. Folders
 *    default CLOSED, sessions default OPEN.
 */

const STORAGE_KEY = 'kortix.project-folder-prefs';

const MAX_TRACKED_PROJECTS = 24;

export type SidebarSection = 'folders' | 'sessions';

function pruneProjects<V>(map: Record<string, V>): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_PROJECTS) return map;
  return Object.fromEntries(keys.slice(-MAX_TRACKED_PROJECTS).map((k) => [k, map[k]]));
}

interface State {
  showAutoByProject: Record<string, Partial<Record<AutoFolderKind, boolean>>>;
  sectionOpenByProject: Record<string, Partial<Record<SidebarSection, boolean>>>;
}

interface Actions {
  setShowAuto: (projectId: string, kind: AutoFolderKind, show: boolean) => void;
  setSectionOpen: (projectId: string, section: SidebarSection, open: boolean) => void;
}

/** Default open state per category: folders closed, sessions open. */
export const SECTION_DEFAULT_OPEN: Record<SidebarSection, boolean> = {
  folders: false,
  sessions: true,
};

export const useSessionFolderUiStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      showAutoByProject: {},
      sectionOpenByProject: {},
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
      setSectionOpen: (projectId, section, open) => {
        const current = get().sectionOpenByProject[projectId] ?? {};
        if ((current[section] ?? SECTION_DEFAULT_OPEN[section]) === open) return;
        set({
          sectionOpenByProject: {
            ...get().sectionOpenByProject,
            [projectId]: { ...current, [section]: open },
          },
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        showAutoByProject: pruneProjects(state.showAutoByProject),
        sectionOpenByProject: pruneProjects(state.sectionOpenByProject),
      }),
    },
  ),
);
