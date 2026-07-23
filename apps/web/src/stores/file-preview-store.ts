import { create } from 'zustand';
import {
  getActivePanelSessionId,
  openFileInSessionPanel,
} from '@/stores/session-browser-store';

interface FilePreviewState {
  /** Whether the preview dialog is open */
  isOpen: boolean;
  /** Path of the file currently being previewed */
  filePath: string | null;
  /** Optional line number to highlight */
  lineNumber?: number;

  /** Open the preview dialog with the given file */
  openPreview: (filePath: string, lineNumber?: number) => void;
  /** Close the preview dialog */
  closePreview: () => void;
}

export const useFilePreviewStore = create<FilePreviewState>((set) => ({
  isOpen: false,
  filePath: null,
  lineNumber: undefined,

  openPreview: (filePath, lineNumber) => {
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
