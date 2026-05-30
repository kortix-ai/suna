'use client';

/**
 * Persisted per-project Version (Git branch) selection for the file viewer.
 *
 * The Versions dropdown writes here; the page-level shell reads the value to
 * override the default-branch ref passed into ProjectFilesProvider. Keyed by
 * projectId so multiple tabs / projects don't fight over the same slot.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

interface VersionStore {
  selectedByProject: Record<string, string | undefined>;
  setVersion: (projectId: string, ref: string | null) => void;
}

export const useVersionStore = create<VersionStore>()(
  persist(
    (set) => ({
      selectedByProject: {},
      setVersion: (projectId, ref) =>
        set((state) => {
          const next = { ...state.selectedByProject };
          if (ref) next[projectId] = ref;
          else delete next[projectId];
          return { selectedByProject: next };
        }),
    }),
    { name: 'kortix-project-version-selection', storage: createSafeJSONStorage() },
  ),
);

export function useSelectedVersion(projectId: string): string | undefined {
  return useVersionStore((s) => s.selectedByProject[projectId]);
}
