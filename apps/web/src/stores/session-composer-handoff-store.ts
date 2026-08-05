import type { AttachedFile } from '@/features/session/session-chat-input';
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

// `usePendingQueueStore` used to live here: a single global list of messages
// typed in the instant shell, consumed once by whichever `SessionChat` mounted
// first. It carried no session id, so a message queued for one session could
// be handed to another. The instant shell now writes straight into
// `message-queue-store`, keyed by session — no handoff, nothing to consume,
// and the queue survives the mount instead of depending on it.
