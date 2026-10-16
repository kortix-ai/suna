'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createSafeJSONStorage } from '@/lib/storage/managed-storage';
import { registerPersistedStore, resetPersistedStore } from '@/stores/persisted-store-registry';

/**
 * How a session's transcript shows its history (P5.6), per session:
 * - `hidden`: the sessions whose messages outside the agent's context (a failed attempt, an
 *   old root's history) are hidden. A session not listed shows them, as the transcript always did.
 * - `dismissedRestore`: the restore generation whose notice the person dismissed, by session.
 *   A later partial restore (a higher generation) shows its notice again.
 * - `outOfContext`: the sessions on screen that hold such a message (not persisted). The
 *   session menu shows the toggle only then: a toggle that changes nothing is a dead row.
 */
const STORAGE_KEY = 'kortix.session-history-view';
/** Keeps the newest ids so the lists cannot grow without bound. */
const MAX_SESSIONS = 200;

interface State {
  hidden: string[];
  dismissedRestore: Record<string, number>;
  outOfContext: Record<string, true>;
  setHidden: (sessionId: string, hidden: boolean) => void;
  dismissRestore: (sessionId: string, generation: number) => void;
  setOutOfContext: (sessionId: string, present: boolean) => void;
}

export const useSessionHistoryViewStore = create<State>()(
  persist(
    (set, get) => ({
      hidden: [],
      dismissedRestore: {},
      outOfContext: {},
      setHidden: (sessionId, hidden) => {
        const current = get().hidden;
        if (current.includes(sessionId) === hidden) return;
        set({ hidden: hidden ? [...current, sessionId].slice(-MAX_SESSIONS) : current.filter((id) => id !== sessionId) });
      },
      dismissRestore: (sessionId, generation) => {
        const entries = Object.entries({ ...get().dismissedRestore, [sessionId]: generation });
        set({ dismissedRestore: Object.fromEntries(entries.slice(-MAX_SESSIONS)) });
      },
      setOutOfContext: (sessionId, present) => {
        if (!!get().outOfContext[sessionId] === present) return;
        const { [sessionId]: _, ...rest } = get().outOfContext;
        set({ outOfContext: present ? { ...rest, [sessionId]: true } : rest });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({ hidden: state.hidden, dismissedRestore: state.dismissedRestore }) as State,
    },
  ),
);

registerPersistedStore(STORAGE_KEY, () => resetPersistedStore(useSessionHistoryViewStore));
