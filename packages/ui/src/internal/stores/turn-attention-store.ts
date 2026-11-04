import { create } from 'zustand';

/**
 * Turns the user has not seen yet, per session: finished turns, and failed
 * turns of another project.
 *
 * The source of truth for the favicon badge (TurnAttentionBadge): a turn that
 * ended while the user was on another tab or another in-app session lands
 * here, and every entry is dropped the moment that session comes into view.
 * In-memory on purpose — the toast and the OS notification it complements are
 * ephemeral too, and the session list has no "unseen" concept to hydrate from.
 */
interface TurnAttentionState {
  /** Session ids whose finished or failed turn the user has not seen yet. */
  unseen: readonly string[];
  /** Record a finished or failed turn for a session the user is not looking at. */
  markTurnComplete: (sessionId: string) => void;
  /** Drop every id the user has now seen (viewed the session or its tab). */
  markSeen: (sessionIds: readonly string[]) => void;
}

export const useTurnAttentionStore = create<TurnAttentionState>()((set) => ({
  unseen: [],

  markTurnComplete: (sessionId) =>
    set((state) =>
      state.unseen.includes(sessionId) ? state : { unseen: [...state.unseen, sessionId] },
    ),

  markSeen: (sessionIds) =>
    set((state) => {
      if (sessionIds.length === 0) return state;
      const seen = new Set(sessionIds);
      const unseen = state.unseen.filter((id) => !seen.has(id));
      return unseen.length === state.unseen.length ? state : { unseen };
    }),
}));
