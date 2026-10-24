'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createSafeJSONStorage } from '../lib/storage/managed-storage';
import { registerPersistedStore, resetPersistedStore } from './persisted-store-registry';

const STORAGE_KEY = 'kortix.active-domain';

/**
 * The domain the user is working inside, per project. `null` = All domains (no
 * scope — every domain plus the shared/General bucket). A domain slug scopes
 * Customize (and the surfaces that opt in) to that one domain's agents,
 * connectors, triggers, reminders and skills. Purely a per-viewer UI context
 * (which space am I looking at) — it is NOT project config, so it lives in
 * localStorage only and never touches `kortix.yaml`.
 */
type ActiveByProject = Record<string, string | null>;

interface ActiveDomainState {
  byProject: ActiveByProject;
  setDomain: (projectId: string, domain: string | null) => void;
}

export const useActiveDomainStore = create<ActiveDomainState>()(
  persist(
    (set) => ({
      byProject: {},
      setDomain: (projectId, domain) =>
        set((state) => ({ byProject: { ...state.byProject, [projectId]: domain } })),
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      version: 1,
      partialize: (state) => ({ byProject: state.byProject }),
    },
  ),
);

registerPersistedStore(STORAGE_KEY, () => resetPersistedStore(useActiveDomainStore));

/** The active domain for a project (`null` = All), and a setter for it. */
export function useActiveDomain(projectId: string): [string | null, (domain: string | null) => void] {
  const domain = useActiveDomainStore((state) => state.byProject[projectId] ?? null);
  const setDomain = useActiveDomainStore((state) => state.setDomain);
  return [domain, (next) => setDomain(projectId, next)];
}
