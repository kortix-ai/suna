/** The session's file preview sheet (web `useFilePreviewStore`); `ToolFilePreviewHost` renders it. */
import { create } from 'zustand';

/** What the sheet shows under a file opened with one: a generated image's prompt (`text`) and the model that made it. */
export interface FileCaption {
  text: string;
  model?: string | null;
}

export interface ToolFilePreviewState {
  path: string | null;
  line: number | undefined;
  /** The caption of this open; null for every file opened without one. */
  caption: FileCaption | null;
  /** The mounted composer's "Add to chat" (mentions the path); null while no composer is mounted. */
  addToChat: ((path: string) => void) | null;
  openPreview: (path: string, line?: number, caption?: FileCaption) => void;
  closePreview: () => void;
  setAddToChat: (addToChat: ((path: string) => void) | null) => void;
}

export const useToolFilePreviewStore = create<ToolFilePreviewState>()((set) => ({
  path: null,
  line: undefined,
  caption: null,
  addToChat: null,
  openPreview: (path, line, caption) => set({ path, line, caption: caption ?? null }),
  closePreview: () => set({ path: null, line: undefined, caption: null }),
  setAddToChat: (addToChat) => set({ addToChat }),
}));
