/**
 * A prompt another surface asks the open thread to send — the session actions
 * sheet's Open change request. `SessionPage` for that session takes the
 * request and sends it the way its composer does: at once when idle, into the
 * message queue while the agent works. One request at a time; a newer one
 * replaces an unsent older one.
 */
import { create } from 'zustand';

export interface SessionPromptRequest {
  id: number;
  sessionId: string;
  text: string;
}

interface SessionPromptRequestState {
  request: SessionPromptRequest | null;
  /** Ask the thread of `sessionId` (its OpenCode id) to send `text`. */
  requestSend: (sessionId: string, text: string) => void;
  /** Remove and return the request for `sessionId`, if there is one. */
  take: (sessionId: string) => SessionPromptRequest | null;
}

let nextId = 1;

export const useSessionPromptRequestStore = create<SessionPromptRequestState>((set, get) => ({
  request: null,
  requestSend: (sessionId, text) => set({ request: { id: nextId++, sessionId, text } }),
  take: (sessionId) => {
    const request = get().request;
    if (!request || request.sessionId !== sessionId) return null;
    set({ request: null });
    return request;
  },
}));
