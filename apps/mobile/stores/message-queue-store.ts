/**
 * Message Queue Store — Zustand store for queuing messages while the agent is busy.
 *
 * Adapted from the frontend's message-queue-store.ts.
 * Uses AsyncStorage instead of localStorage for persistence on mobile.
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const QUEUE_STORAGE_KEY = 'kortix_message_queue_v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
  timestamp: number;
}

interface MessageQueueState {
  messages: QueuedMessage[];
  /** Whether local queue state has been loaded from AsyncStorage */
  hydrated: boolean;

  /** Load stored messages from AsyncStorage (call once on app start) */
  hydrate: () => Promise<void>;

  /** Add a message to the queue for a given session */
  enqueue: (sessionId: string, text: string) => void;

  /** Remove a specific message from the queue by ID */
  remove: (messageId: string) => void;

  /** Remove and return the first message in the queue for a session */
  dequeue: (sessionId: string) => QueuedMessage | undefined;

  /** Get all queued messages for a specific session */
  getSessionMessages: (sessionId: string) => QueuedMessage[];

  /** Move a message up in the queue (swap with previous in same session) */
  moveUp: (messageId: string) => void;

  /** Move a message down in the queue (swap with next in same session) */
  moveDown: (messageId: string) => void;

  /** Clear all messages for a session */
  clearSession: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function persistMessages(messages: QueuedMessage[]): void {
  const serializable = messages.map(({ id, sessionId, text, timestamp }) => ({
    id,
    sessionId,
    text,
    timestamp,
  }));
  AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(serializable)).catch(
    () => {
      // no-op
    },
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useMessageQueueStore = create<MessageQueueState>()((set, get) => ({
  messages: [],
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
      if (!raw) {
        set({ hydrated: true });
        return;
      }
      const parsed = JSON.parse(raw) as Array<
        Pick<QueuedMessage, 'id' | 'sessionId' | 'text' | 'timestamp'>
      >;
      if (!Array.isArray(parsed)) {
        set({ hydrated: true });
        return;
      }
      const messages = parsed
        .filter(
          (m) => m && m.id && m.sessionId && typeof m.text === 'string',
        )
        .map((m) => ({
          id: m.id,
          sessionId: m.sessionId,
          text: m.text,
          timestamp: Number(m.timestamp) || Date.now(),
        }));
      set({ messages, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  enqueue: (sessionId, text) => {
    const message: QueuedMessage = {
      id: `queued-${Crypto.randomUUID()}`,
      sessionId,
      text,
      timestamp: Date.now(),
    };
    set((state) => {
      const next = [...state.messages, message];
      persistMessages(next);
      return { messages: next };
    });
  },

  remove: (messageId) => {
    set((state) => {
      const next = state.messages.filter((m) => m.id !== messageId);
      persistMessages(next);
      return { messages: next };
    });
  },

  dequeue: (sessionId) => {
    const state = get();
    const sessionMessages = state.messages.filter(
      (m) => m.sessionId === sessionId,
    );
    if (sessionMessages.length === 0) return undefined;
    const first = sessionMessages[0];
    set((s) => {
      const next = s.messages.filter((m) => m.id !== first.id);
      persistMessages(next);
      return { messages: next };
    });
    return first;
  },

  getSessionMessages: (sessionId) => {
    return get().messages.filter((m) => m.sessionId === sessionId);
  },

  moveUp: (messageId) => {
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx <= 0) return state;
      const msg = state.messages[idx];
      const sessionMessages = state.messages.filter(
        (m) => m.sessionId === msg.sessionId,
      );
      const sessionIdx = sessionMessages.findIndex(
        (m) => m.id === messageId,
      );
      if (sessionIdx <= 0) return state;
      const prevInSession = sessionMessages[sessionIdx - 1];
      const prevIdx = state.messages.findIndex(
        (m) => m.id === prevInSession.id,
      );
      const next = [...state.messages];
      [next[prevIdx], next[idx]] = [next[idx], next[prevIdx]];
      persistMessages(next);
      return { messages: next };
    });
  },

  moveDown: (messageId) => {
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;
      const msg = state.messages[idx];
      const sessionMessages = state.messages.filter(
        (m) => m.sessionId === msg.sessionId,
      );
      const sessionIdx = sessionMessages.findIndex(
        (m) => m.id === messageId,
      );
      if (sessionIdx >= sessionMessages.length - 1) return state;
      const nextInSession = sessionMessages[sessionIdx + 1];
      const nextIdx = state.messages.findIndex(
        (m) => m.id === nextInSession.id,
      );
      const next = [...state.messages];
      [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
      persistMessages(next);
      return { messages: next };
    });
  },

  clearSession: (sessionId) => {
    set((state) => {
      const next = state.messages.filter(
        (m) => m.sessionId !== sessionId,
      );
      persistMessages(next);
      return { messages: next };
    });
  },
}));
