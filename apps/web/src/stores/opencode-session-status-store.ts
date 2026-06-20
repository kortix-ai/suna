'use client';

import { create } from 'zustand';
import type { SessionStatus } from '@opencode-ai/sdk/v2/client';

interface SessionStatusState {
  statuses: Record<string, SessionStatus>;
  setStatus: (sessionId: string, status: SessionStatus) => void;
  setStatuses: (statuses: Record<string, SessionStatus>) => void;
}

export const useOpenCodeSessionStatusStore = create<SessionStatusState>()((set) => ({
  statuses: {},
  setStatus: (sessionId, status) =>
    set((state) => ({
      statuses: { ...state.statuses, [sessionId]: status },
    })),
  setStatuses: (statuses) => set({ statuses }),
}));
