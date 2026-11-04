'use client';

import { create } from 'zustand';

/** A call: a session of its own on an agent, placed from that agent's page. */
export interface ActiveCall {
  projectId: string;
  sessionId: string;
  /** The agent's name (its slug): the card's mark and name. */
  agent: string;
  /** When it was placed (ms), for "Calling…" before the box answers. */
  placedAt: number;
}

/**
 * The call in progress, one at a time, as there is one microphone. The agent page's Call button places it and the
 * call card (voice-call-card.tsx, in the project shell) runs it wherever the person goes in the project, until it is
 * hung up.
 */
interface VoiceCallStore {
  call: ActiveCall | null;
  place: (call: Omit<ActiveCall, 'placedAt'>) => void;
  /** Ends the call (only that session's, when one is named). */
  end: (sessionId?: string) => void;
}

export const useVoiceCallStore = create<VoiceCallStore>()((set, get) => ({
  call: null,
  place: (call) => set({ call: { ...call, placedAt: Date.now() } }),
  end: (sessionId) => {
    if (!sessionId || get().call?.sessionId === sessionId) set({ call: null });
  },
}));
