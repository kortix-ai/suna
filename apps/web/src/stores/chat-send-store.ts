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
 * Each sender owns its OpenCode chat id and can register the durable project
 * session id as an alias. This lets route-level controls reach the active chat
 * without learning the runtime's internal id.
 */
export type ChatSendDisposition = 'sent' | 'queued';
type ChatSender = (text: string) => Promise<ChatSendDisposition>;
type RegisteredChatSender = { ownerId: string; send: ChatSender };

interface ChatSendState {
  senders: Record<string, RegisteredChatSender>;
  registerSender: (sessionId: string, sender: ChatSender, aliases?: string[]) => void;
  unregisterSender: (sessionId: string) => void;
  /**
   * Send `text` to the agent in `sessionId`. Rejects if no chat is mounted for
   * that session, or if the underlying send fails — callers should surface the
   * reason to the user.
   */
  sendToSession: (sessionId: string, text: string) => Promise<ChatSendDisposition>;
}

export const useChatSendStore = create<ChatSendState>()((set, get) => ({
  senders: {},

  registerSender: (sessionId, sender, aliases = []) =>
    set((state) => {
      const registration = { ownerId: sessionId, send: sender };
      const registrations = Object.fromEntries(
        [sessionId, ...aliases].map((id) => [id, registration]),
      );
      return { senders: { ...state.senders, ...registrations } };
    }),

  unregisterSender: (sessionId) =>
    set((state) => {
      return {
        senders: Object.fromEntries(
          Object.entries(state.senders).filter(([, sender]) => sender.ownerId !== sessionId),
        ),
      };
    }),

  sendToSession: async (sessionId, text) => {
    const registration = get().senders[sessionId];
    if (!registration) {
      throw new Error('The conversation is still loading — open it and try again in a moment.');
    }
    return registration.send(text);
  },
}));
