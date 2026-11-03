'use client';

import { create } from 'zustand';

/**
 * The session (Kortix session id) whose call bar is open: one call at a time, as there is one microphone. The agent
 * page's Call button opens it for the session it starts, and the bar above that session's composer runs the call
 * while it is open.
 */
interface VoiceCallStore {
  sessionId: string | null;
  open: (sessionId: string) => void;
  close: (sessionId: string) => void;
}

export const useVoiceCallStore = create<VoiceCallStore>()((set, get) => ({
  sessionId: null,
  open: (sessionId) => set({ sessionId }),
  close: (sessionId) => {
    if (get().sessionId === sessionId) set({ sessionId: null });
  },
}));
