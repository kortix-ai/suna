'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createSafeJSONStorage } from '../lib/storage/managed-storage';
import { registerPersistedStore, resetPersistedStore } from './persisted-store-registry';

const STORAGE_KEY = 'kortix.active-space';

/**
 * The space the user is working inside, per project. `null` = no space (no
 * scope: every space plus the Project-wide bucket). A space slug scopes
 * Customize (and the surfaces that opt in) to that one space's agents,
 * connectors, triggers, reminders and skills. Purely a per-viewer UI context
 * (which space am I looking at) — it is NOT project config, so it lives in
 * localStorage only and never touches `kortix.yaml`.
 */
type ActiveByProject = Record<string, string | null>;

interface ActiveSpaceState {
  byProject: ActiveByProject;
  setSpace: (projectId: string, space: string | null) => void;
}

export const useActiveSpaceStore = create<ActiveSpaceState>()(
  persist(
    (set) => ({
      byProject: {},
      setSpace: (projectId, space) =>
        set((state) => ({ byProject: { ...state.byProject, [projectId]: space } })),
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      version: 1,
      partialize: (state) => ({ byProject: state.byProject }),
    },
  ),
);

registerPersistedStore(STORAGE_KEY, () => resetPersistedStore(useActiveSpaceStore));

/** The active space for a project (`null` = All), and a setter for it. */
export function useActiveSpace(projectId: string): [string | null, (space: string | null) => void] {
  const space = useActiveSpaceStore((state) => state.byProject[projectId] ?? null);
  const setSpace = useActiveSpaceStore((state) => state.setSpace);
  return [space, (next) => setSpace(projectId, next)];
}
