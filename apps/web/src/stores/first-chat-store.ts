import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createSafeJSONStorage } from '@/lib/storage/managed-storage';
import { registerPersistedStore, resetPersistedStore } from '@/stores/persisted-store-registry';

/**
 * Projects whose first chat is waiting for its first message.
 *
 * Onboarding starts it. While it is pending, project home opens on the welcome
 * chat (`project-layout/home/first-chat.tsx`) and an empty sidebar list shows
 * one "Your first chat with Kortix" row. The first successful send finishes it.
 *
 * The welcome chat is not a session. Nothing is created and no turn runs until
 * the person sends something, so the state lives here in the browser, not on
 * the server.
 */

/** `kortix.` is an app prefix, so sign-out sweeps it
 *  (`persisted-store-coverage.test.ts`). */
const STORAGE_KEY = 'kortix.firstChat';

interface FirstChatState {
  projectIds: string[];
  start: (projectId: string) => void;
  finish: (projectId: string) => void;
}

export const useFirstChatStore = create<FirstChatState>()(
  persist(
    (set) => ({
      projectIds: [],
      start: (projectId) =>
        set((state) =>
          state.projectIds.includes(projectId)
            ? state
            : { projectIds: [...state.projectIds, projectId] },
        ),
      finish: (projectId) =>
        set((state) =>
          state.projectIds.includes(projectId)
            ? { projectIds: state.projectIds.filter((id) => id !== projectId) }
            : state,
        ),
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      version: 1,
      partialize: (state) => ({ projectIds: state.projectIds }),
    },
  ),
);

registerPersistedStore(STORAGE_KEY, () => resetPersistedStore(useFirstChatStore));

export function useFirstChatPending(projectId: string): boolean {
  return useFirstChatStore((state) => state.projectIds.includes(projectId));
}
