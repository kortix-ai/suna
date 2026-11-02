'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createSafeJSONStorage } from '../lib/storage/managed-storage';
import { registerPersistedStore, resetPersistedStore } from './persisted-store-registry';

const STORAGE_KEY = 'kortix.pinned-agents';

/**
 * The agents each person pins to the sidebar's Customize, per project. A
 * view preference of this browser, like the session list's: nothing in the
 * project's config changes. No pins: Customize shows the first agents.
 */
interface PinnedAgentsState {
  byProject: Record<string, string[]>;
  togglePinned: (projectId: string, agent: string) => void;
}

const EMPTY: string[] = [];

export const usePinnedAgentsStore = create<PinnedAgentsState>()(
  persist(
    (set, get) => ({
      byProject: {},
      togglePinned: (projectId, agent) => {
        const current = get().byProject[projectId] ?? EMPTY;
        const next = current.includes(agent) ? current.filter((name) => name !== agent) : [...current, agent];
        set({ byProject: { ...get().byProject, [projectId]: next } });
      },
    }),
    { name: STORAGE_KEY, storage: createSafeJSONStorage(), partialize: (state) => ({ byProject: state.byProject }) },
  ),
);

/** The agents pinned in this project, in pin order. */
export function usePinnedAgents(projectId: string): string[] {
  return usePinnedAgentsStore((state) => state.byProject[projectId] ?? EMPTY);
}

registerPersistedStore(STORAGE_KEY, () => resetPersistedStore(usePinnedAgentsStore));
