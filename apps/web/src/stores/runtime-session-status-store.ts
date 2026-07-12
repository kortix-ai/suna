'use client';

import { create } from 'zustand';

export type SessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | {
      type: 'retry';
      attempt: number;
      message: string;
      next: number;
      action?: {
        reason: string;
        provider: string;
        title: string;
        message: string;
        label: string;
        link?: string;
      };
    };

interface SessionStatusState {
  statuses: Record<string, SessionStatus>;
  setStatus: (sessionId: string, status: SessionStatus) => void;
  setStatuses: (statuses: Record<string, SessionStatus>) => void;
}

export const useRuntimeSessionStatusStore = create<SessionStatusState>()((set) => ({
  statuses: {},
  setStatus: (sessionId, status) =>
    set((state) => ({
      statuses: { ...state.statuses, [sessionId]: status },
    })),
  setStatuses: (statuses) => set({ statuses }),
}));
