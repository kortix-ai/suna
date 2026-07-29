import type {
  AttachedFile,
  TrackedMention,
} from '@/features/session/session-chat-input';
import { create } from 'zustand';

interface PendingFilesState {
  files: AttachedFile[];
  setPendingFiles: (files: AttachedFile[]) => void;
  consumePendingFiles: () => AttachedFile[];
}

export const usePendingFilesStore = create<PendingFilesState>((set, get) => ({
  files: [],
  setPendingFiles: (files) => set({ files }),
  consumePendingFiles: () => {
    const files = get().files;
    set({ files: [] });
    return files;
  },
}));

export interface PendingQueuedMessage {
  id: string;
  text: string;
  files?: AttachedFile[];
  mentions?: TrackedMention[];
}

interface PendingQueueState {
  messages: PendingQueuedMessage[];
  queueMessage: (
    text: string,
    files?: AttachedFile[],
    mentions?: TrackedMention[],
  ) => void;
  removeMessage: (id: string) => void;
  consumePendingQueue: () => PendingQueuedMessage[];
}

let pendingQueueIdCounter = 0;

export const usePendingQueueStore = create<PendingQueueState>((set, get) => ({
  messages: [],
  queueMessage: (text, files, mentions) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: `pending-queue-${++pendingQueueIdCounter}`,
          text,
          files,
          mentions,
        },
      ],
    })),
  removeMessage: (id) =>
    set((state) => ({
      messages: state.messages.filter((message) => message.id !== id),
    })),
  consumePendingQueue: () => {
    const messages = get().messages;
    set({ messages: [] });
    return messages;
  },
}));
