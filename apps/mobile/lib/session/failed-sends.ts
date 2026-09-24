/**
 * Failed sends (COR-143): a thread message whose prompt never reached the
 * runtime. The optimistic user message stays in the thread, dimmed, with
 * "Not sent · Try again"; this store keeps what a retry sends again. Web keeps
 * a failed accepted send on screen the same way (`uploadStatus` on
 * `apps/web/src/features/session/turn/user-message.tsx`).
 *
 * In memory only: the payload is the text as sent — any attachments already
 * uploaded and referenced in it — plus the send options.
 */

import { create } from 'zustand';

export interface FailedSend<TOptions = unknown, TMentions = unknown> {
  /** The text `handleSend` was called with (attachment refs included). */
  text: string;
  options: TOptions;
  mentions?: TMentions;
}

type BySession = Record<string, Record<string, FailedSend>>;

interface FailedSendState {
  /** session id → optimistic message id → payload */
  bySession: BySession;
  markFailed: (sessionId: string, messageId: string, send: FailedSend) => void;
  /** Removes and returns the payload; undefined when absent (a double tap). */
  take: (sessionId: string, messageId: string) => FailedSend | undefined;
}

export function withFailed(state: BySession, sessionId: string, messageId: string, send: FailedSend): BySession {
  return { ...state, [sessionId]: { ...state[sessionId], [messageId]: send } };
}

export function withoutFailed(state: BySession, sessionId: string, messageId: string): BySession {
  const session = state[sessionId];
  if (!session || !(messageId in session)) return state;
  const nextSession = { ...session };
  delete nextSession[messageId];
  const next = { ...state };
  if (Object.keys(nextSession).length > 0) next[sessionId] = nextSession;
  else delete next[sessionId];
  return next;
}

export const useFailedSendStore = create<FailedSendState>((set, get) => ({
  bySession: {},
  markFailed: (sessionId, messageId, send) =>
    set((state) => ({ bySession: withFailed(state.bySession, sessionId, messageId, send) })),
  take: (sessionId, messageId) => {
    const send = get().bySession[sessionId]?.[messageId];
    if (!send) return undefined;
    set((state) => ({ bySession: withoutFailed(state.bySession, sessionId, messageId) }));
    return send;
  },
}));

const EMPTY: Record<string, FailedSend> = {};

/** The failed sends of one session, by message id. Stable when empty. */
export function useFailedSends(sessionId: string): Record<string, FailedSend> {
  return useFailedSendStore((state) => state.bySession[sessionId] ?? EMPTY);
}
