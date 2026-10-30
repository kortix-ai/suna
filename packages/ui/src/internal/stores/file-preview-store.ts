import { getActivePanelSessionId, openFileInSessionPanel } from './session-browser-store';
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

/**
 * What the full-screen viewer shows under a file opened with one: a generated
 * image's prompt (`text`) and the model that made it.
 */
export interface FileCaption {
  text: string;
  model?: string | null;
  /**
   * The sha256 of the image's bytes (R38): the viewer draws those bytes from
   * the shared store at once, with no read.
   */
  sha256?: string;
}

/** One key per sandbox file, with or without the `/workspace/` prefix. */
export function fileCaptionKey(path: string): string {
  return path.trim().replace(/^\/?workspace\//, '').replace(/^\/+/, '');
}

interface FilePreviewState {
  /** Whether the preview dialog is open */
  isOpen: boolean;
  /** Path of the file currently being previewed */
  filePath: string | null;
  /** Optional line number to highlight */
  lineNumber?: number;
  /**
   * Captions of the files opened with one, by `fileCaptionKey`. Kept after
   * the open: the session panel's viewer, the Files explorer and this dialog
   * all read it for the path they show.
   */
  captions: Record<string, FileCaption>;

  /** Open the preview dialog with the given file; `caption` shows under it in the viewer. */
  openPreview: (filePath: string, lineNumber?: number, caption?: FileCaption) => void;
  /** Close the preview dialog */
  closePreview: () => void;
}

export const useFilePreviewStore = create<FilePreviewState>((set) => ({
  isOpen: false,
  filePath: null,
  lineNumber: undefined,
  captions: {},

  openPreview: (filePath, lineNumber, caption) => {
    if (caption) set((s) => ({ captions: { ...s.captions, [fileCaptionKey(filePath)]: caption } }));
    // Inside a session the file opens in the panel's detail layer — the THING,
    // not the file manager around it (see easy-panel.tsx's handleOpenOutput).
    // `…Silently` because Easy must never write `viewBySession`: that key is
    // Advanced's resume point, and session-layout.tsx promises Easy leaves it
    // untouched. The modal below is the fallback for surfaces with no side
    // panel — the dashboard and project pages.
    const sessionId = getActivePanelSessionId();
    if (sessionId) {
      openFileInSessionPanel(sessionId, filePath, lineNumber);
      return;
    }
    set({ isOpen: true, filePath, lineNumber });
  },

  closePreview: () => {
    set({ isOpen: false, filePath: null, lineNumber: undefined });
  },
}));

/**
 * The caption the viewer shows under `filePath`, when it was opened with one.
 * The live state on both snapshots: a static render (tests, a prerender)
 * reads what was opened, not the store's initial state.
 */
export function useFileCaption(filePath: string): FileCaption | undefined {
  const key = fileCaptionKey(filePath);
  const read = () => useFilePreviewStore.getState().captions[key];
  return useSyncExternalStore(useFilePreviewStore.subscribe, read, read);
}
