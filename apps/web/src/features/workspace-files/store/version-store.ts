'use client';

/**
 * Persisted per-workspace Version (Git branch) selection for the file viewer.
 *
 * The Versions dropdown writes here; the page-level shell reads the value to
 * override the default-branch ref passed into WorkspaceFilesProvider. Keyed by
 * workspaceId so multiple tabs and workspaces do not fight over the same slot.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

interface VersionStore {
  selectedByWorkspace: Record<string, string | undefined>;
  setVersion: (workspaceId: string, ref: string | null) => void;
}

export const useVersionStore = create<VersionStore>()(
  persist(
    (set) => ({
      selectedByWorkspace: {},
      setVersion: (workspaceId, ref) =>
        set((state) => {
          const next = { ...state.selectedByWorkspace };
          if (ref) next[workspaceId] = ref;
          else delete next[workspaceId];
          return { selectedByWorkspace: next };
        }),
    }),
    {
      // Keep the legacy storage key so existing branch selections survive.
      name: 'kortix-project-version-selection',
      storage: createSafeJSONStorage(),
      version: 1,
      migrate: (persisted) => {
        const legacy = persisted as Partial<VersionStore> & {
          selectedByProject?: Record<string, string | undefined>;
        };
        return {
          ...legacy,
          selectedByWorkspace: legacy.selectedByWorkspace ?? legacy.selectedByProject ?? {},
        } as VersionStore;
      },
    },
  ),
);

export function useSelectedVersion(workspaceId: string): string | undefined {
  return useVersionStore((s) => s.selectedByWorkspace[workspaceId]);
}
