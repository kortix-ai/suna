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
    // Inside a session, files open in the side panel's Files tab (inline, with
    // an Expand button) rather than this full-screen modal. The modal is the
    // fallback for surfaces with no side panel (e.g. the dashboard).
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
