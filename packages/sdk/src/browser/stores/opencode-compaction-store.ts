'use client';

import { create } from 'zustand';

interface OpenCodeCompactionState {
  /**
   * ms epoch at which THIS tab issued `/compact` for a session.
   *
   * A stamp rather than a boolean, because the flag it replaced was cleared
   * only by the `session.compacted` SSE frame — miss that frame and the
   * composer was pinned for the lifetime of the tab. `projectCompacting`
   * (`core/session/compaction.ts`) bounds the stamp; nothing here is authority.
   */
  compactingBySession: Record<string, number>;
  startCompaction: (sessionId: string) => void;
  stopCompaction: (sessionId: string) => void;
}

export const useOpenCodeCompactionStore = create<OpenCodeCompactionState>()((set) => ({
  compactingBySession: {},
  startCompaction: (sessionId) =>
    set((state) => {
      // Keep the FIRST stamp: re-stamping would extend the cap every time a
      // second `/compact` fired, which is the latch in slow motion. `in`, not
      // truthiness — an epoch is a number, and a re-issue must not restart it.
      if (sessionId in state.compactingBySession) return state;
      return {
        compactingBySession: {
          ...state.compactingBySession,
          [sessionId]: Date.now(),
        },
      };
    }),
  stopCompaction: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.compactingBySession)) return state;
      const { [sessionId]: _, ...rest } = state.compactingBySession;
      return { compactingBySession: rest };
    }),
}));
