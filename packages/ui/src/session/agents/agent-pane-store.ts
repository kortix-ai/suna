'use client';

import { create } from 'zustand';

/**
 * Which agent session the agent pane shows right now. The pane writes it while
 * it is mounted; a workflow row reads it to mark itself "Viewing", so the
 * transcript and the pane point at the same agent. Not persisted: a reload
 * closes the pane.
 */
interface AgentPaneState {
  sessionId: string | null;
  setViewing: (sessionId: string | null) => void;
}

export const useAgentPaneStore = create<AgentPaneState>((set) => ({
  sessionId: null,
  setViewing: (sessionId) => set({ sessionId }),
}));

/** True while the agent pane shows `sessionId`. */
export function useViewingAgent(sessionId: string | undefined): boolean {
  return useAgentPaneStore((state) => !!sessionId && state.sessionId === sessionId);
}
