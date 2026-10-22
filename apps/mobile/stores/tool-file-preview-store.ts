/** The session's file preview sheet (web `useFilePreviewStore`); `ToolFilePreviewHost` renders it. */
import { create } from 'zustand';

export interface ToolFilePreviewState {
  path: string | null;
  line: number | undefined;
  /** The mounted composer's "Add to chat" (mentions the path); null while no composer is mounted. */
  addToChat: ((path: string) => void) | null;
  openPreview: (path: string, line?: number) => void;
  closePreview: () => void;
  setAddToChat: (addToChat: ((path: string) => void) | null) => void;
}

export const useToolFilePreviewStore = create<ToolFilePreviewState>()((set) => ({
  path: null,
  line: undefined,
  addToChat: null,
  openPreview: (path, line) => set({ path, line }),
  closePreview: () => set({ path: null, line: undefined }),
  setAddToChat: (addToChat) => set({ addToChat }),
}));
