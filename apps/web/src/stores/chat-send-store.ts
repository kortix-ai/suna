'use client';

import { create } from 'zustand';

/**
 * Lets any component send a message to the agent of an already-mounted chat
 * session WITHOUT owning the chat's send machinery.
 *
 * `SessionChat` registers its canonical `handleSend` (optimistic message,
 * SSE wiring, error propagation, draft restore) under its session id; siblings
 * like the "Changes" side panel call `sendToSession(...)` to drive it. This
 * replaces the old copy-prompt-to-clipboard hack, which existed only because
 * the panel had no reliable way to reach the chat's sender from outside it.
 *
 * Keyed by the OpenCode chat session id (the one `handleSend` posts to) — not
 * the route/git session id — so pre-mounted tab sessions never collide.
 */
type ChatSender = (text: string) => Promise<unknown>;

interface ChatSendState {
  senders: Record<string, ChatSender>;
  registerSender: (sessionId: string, sender: ChatSender) => void;
  unregisterSender: (sessionId: string) => void;
  /**
   * Send `text` to the agent in `sessionId`. Rejects if no chat is mounted for
   * that session, or if the underlying send fails — callers should surface the
   * reason to the user.
   */
  sendToSession: (sessionId: string, text: string) => Promise<void>;
}

export const useChatSendStore = create<ChatSendState>()((set, get) => ({
  senders: {},

  registerSender: (sessionId, sender) =>
    set((state) => ({ senders: { ...state.senders, [sessionId]: sender } })),

  unregisterSender: (sessionId) =>
    set((state) => {
      const { [sessionId]: _removed, ...rest } = state.senders;
      return { senders: rest };
    }),

  sendToSession: async (sessionId, text) => {
    const sender = get().senders[sessionId];
    if (!sender) {
      throw new Error(
        'The conversation is still loading — open it and try again in a moment.',
      );
    }
    await sender(text);
  },
}));
