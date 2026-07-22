import type { AttachedFile, TrackedMention } from '@/features/session/session-chat-input';
import { create } from 'zustand';

export interface PendingQueuedMessage {
  id: string;
  text: string;
  files?: AttachedFile[];
  mentions?: TrackedMention[];
}

interface PendingQueueState {
  /** Messages typed while the instant shell was still booting the computer,
   *  held until the real SessionChat mounts and drains them (same lifecycle as
   *  pending-files-store's first-message files). */
  messages: PendingQueuedMessage[];
  queueMessage: (text: string, files?: AttachedFile[], mentions?: TrackedMention[]) => void;
  removeMessage: (id: string) => void;
  /** Consume (take and clear) the pending queue */
  consumePendingQueue: () => PendingQueuedMessage[];
}

let pendingQueueIdCounter = 0;

export const usePendingQueueStore = create<PendingQueueState>((set, get) => ({
  messages: [],
  queueMessage: (text, files, mentions) =>
    set((state) => ({
      messages: [
        ...state.messages,
        { id: `pending-queue-${++pendingQueueIdCounter}`, text, files, mentions },
      ],
    })),
  removeMessage: (id) =>
    set((state) => ({ messages: state.messages.filter((m) => m.id !== id) })),
  consumePendingQueue: () => {
    const messages = get().messages;
    set({ messages: [] });
    return messages;
  },
}));
