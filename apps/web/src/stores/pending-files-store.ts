import type { AttachedFile } from '@/features/session/session-chat-input';
import { create } from 'zustand';

interface PendingFilesState {
  /** Files waiting to be sent with the first message of a new session */
  files: AttachedFile[];
  /** Store files for a pending send */
  setPendingFiles: (files: AttachedFile[]) => void;
  /** Consume (take and clear) pending files */
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
