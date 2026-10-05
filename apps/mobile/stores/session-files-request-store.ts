/**
 * A request to open a thread's Recent files sheet — the session actions
 * sheet's Files row and the composer's Add sheet. The `SessionPage` of that
 * thread takes the request and opens its `SessionFilesSheet`, also while a
 * question replaces the composer. A request older than the page (made while
 * the thread was still waking) is ignored. Keyed by the runtime session id
 * (the tab store's `activeSessionId`, which is also `SessionPage`'s
 * `sessionId`). One request at a time.
 */
import { create } from 'zustand';

export interface SessionFilesRequest {
  id: number;
  sessionId: string;
}

interface SessionFilesRequestState {
  request: SessionFilesRequest | null;
  requestOpen: (sessionId: string) => void;
  /** Remove and return the request for `sessionId`, if there is one. */
  take: (sessionId: string) => SessionFilesRequest | null;
}

let nextId = 1;

export const useSessionFilesRequestStore = create<SessionFilesRequestState>((set, get) => ({
  request: null,
  requestOpen: (sessionId) => set({ request: { id: nextId++, sessionId } }),
  take: (sessionId) => {
    const request = get().request;
    if (!request || request.sessionId !== sessionId) return null;
    set({ request: null });
    return request;
  },
}));
