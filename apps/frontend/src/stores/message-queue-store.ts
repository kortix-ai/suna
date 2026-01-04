'use client';

import { create } from 'zustand';

export interface QueuedMessage {
  id: string;
  message: string;
  threadId: string;
  options?: { model_name?: string; agent_id?: string };
  timestamp: number;
}

interface MessageQueueState {
  queuedMessages: QueuedMessage[];
  
  // Actions
  queueMessage: (threadId: string, message: string, options?: { model_name?: string; agent_id?: string }) => string;
  removeMessage: (id: string) => void;
  clearQueue: (threadId?: string) => void;
  getMessagesForThread: (threadId: string) => QueuedMessage[];
  moveUp: (id: string, threadId: string) => void;
  moveDown: (id: string, threadId: string) => void;
}

export const useMessageQueueStore = create<MessageQueueState>((set, get) => ({
  queuedMessages: [],

  queueMessage: (threadId, message, options) => {
    const id = `queued-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const queuedMessage: QueuedMessage = {
      id,
      threadId,
      message,
      options,
      timestamp: Date.now(),
    };
    
    console.log('[MessageQueueStore] Queueing message:', queuedMessage);
    set((state) => ({
      queuedMessages: [...state.queuedMessages, queuedMessage],
    }));
    
    return id;
  },

  removeMessage: (id) => {
    console.log('[MessageQueueStore] Removing message:', id);
    set((state) => ({
      queuedMessages: state.queuedMessages.filter((msg) => msg.id !== id),
    }));
  },

  clearQueue: (threadId) => {
    console.log('[MessageQueueStore] Clearing queue for thread:', threadId);
    if (threadId) {
      set((state) => ({
        queuedMessages: state.queuedMessages.filter((msg) => msg.threadId !== threadId),
      }));
    } else {
      set({ queuedMessages: [] });
    }
  },

  getMessagesForThread: (threadId) => {
    return get().queuedMessages.filter((msg) => msg.threadId === threadId);
  },

  moveUp: (id, threadId) => {
    set((state) => {
      const threadMessages = state.queuedMessages.filter((msg) => msg.threadId === threadId);
      const otherMessages = state.queuedMessages.filter((msg) => msg.threadId !== threadId);
      const index = threadMessages.findIndex((msg) => msg.id === id);
      if (index <= 0) return state; // Already at top or not found
      
      const newThreadMessages = [...threadMessages];
      [newThreadMessages[index - 1], newThreadMessages[index]] = [newThreadMessages[index], newThreadMessages[index - 1]];
      
      return { queuedMessages: [...otherMessages, ...newThreadMessages] };
    });
  },

  moveDown: (id, threadId) => {
    set((state) => {
      const threadMessages = state.queuedMessages.filter((msg) => msg.threadId === threadId);
      const otherMessages = state.queuedMessages.filter((msg) => msg.threadId !== threadId);
      const index = threadMessages.findIndex((msg) => msg.id === id);
      if (index < 0 || index >= threadMessages.length - 1) return state; // Already at bottom or not found
      
      const newThreadMessages = [...threadMessages];
      [newThreadMessages[index], newThreadMessages[index + 1]] = [newThreadMessages[index + 1], newThreadMessages[index]];
      
      return { queuedMessages: [...otherMessages, ...newThreadMessages] };
    });
  },
}));

// Selectors
export const selectQueuedMessagesForThread = (threadId: string) => (state: MessageQueueState) =>
  state.queuedMessages.filter((msg) => msg.threadId === threadId);
