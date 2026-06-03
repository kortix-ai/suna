import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { HIDE_BROWSER_TAB } from '@/components/thread/utils';
import { useFilesStore } from '@/features/files';
import { useFilePreviewStore } from '@/stores/file-preview-store';

export type ViewType = 'tools' | 'files' | 'browser' | 'desktop' | 'terminal' | 'changes';

interface KortixComputerState {
  // Main view state
  activeView: ViewType;
  
  // Panel state — per-session so switching tabs preserves each session's panel state
  shouldOpenPanel: boolean;
  isSidePanelOpen: boolean;
  _panelOpenBySession: Record<string, boolean>;
  _activeSessionId: string | null;
  isExpanded: boolean;
  
  // Tool navigation state (for external tool click triggers)
  pendingToolNavIndex: number | null;

  // Side-panel Actions focus — the tool callID the panel should jump to when
  // the user clicks a tool call in the chat. By callID (not index) so it stays
  // correct regardless of ordering.
  focusedToolCallId: string | null;

  // === ACTIONS ===
  
  setActiveView: (view: ViewType) => void;
  
  // For external triggers (clicking file in chat) — delegates to useFilesStore + opens panel
  openFileInComputer: (filePath: string, filePathList?: string[], targetLine?: number) => void;
  
  // Open files browser without selecting a file — delegates to useFilesStore + opens panel
  openFileBrowser: () => void;
  
  // Navigate to a specific tool call (clicking tool in ThreadContent)
  navigateToToolCall: (toolIndex: number) => void;

  // Clear pending tool nav after KortixComputer processes it
  clearPendingToolNav: () => void;

  // Open the side panel (Actions view) focused on a specific tool call.
  focusToolCall: (callId: string) => void;
  // Clear the focus request after the panel has jumped to it.
  clearFocusedToolCall: () => void;
  
  // Panel control
  clearShouldOpenPanel: () => void;
  setIsSidePanelOpen: (open: boolean) => void;
  /** Call when a session tab becomes active — restores that session's panel state */
  setActiveSession: (sessionId: string | null) => void;
  openSidePanel: () => void;
  closeSidePanel: () => void;
  setIsExpanded: (expanded: boolean) => void;
  toggleExpanded: () => void;
  
  // Reset all state (full reset)
  reset: () => void;
}

const initialState = {
  activeView: 'tools' as ViewType,
  shouldOpenPanel: false,
  isSidePanelOpen: false,
  _panelOpenBySession: {} as Record<string, boolean>,
  _activeSessionId: null as string | null,
  isExpanded: false,
  pendingToolNavIndex: null as number | null,
  focusedToolCallId: null as string | null,
};

export const useKortixComputerStore = create<KortixComputerState>()(
  devtools(
    (set, get) => ({
      ...initialState,

      setActiveView: (view: ViewType) => {
        // If browser tab is hidden and trying to set browser view, default to tools
        const effectiveView = HIDE_BROWSER_TAB && view === 'browser' ? 'tools' : view;
        // Terminal and Desktop are now in the right sidebar - redirect to tools
        const finalView = (effectiveView === 'terminal' || effectiveView === 'desktop' || effectiveView === 'changes') ? 'tools' : effectiveView;
        set({ activeView: finalView });
      },
      
      openFileInComputer: (filePath: string, _filePathList?: string[], targetLine?: number) => {
        // Open the file in the global preview dialog (same as clicking a file
        // in the explorer / a path in chat).
        useFilePreviewStore.getState().openPreview(filePath, targetLine);
      },
      
      openFileBrowser: () => {
        // Delegate file state to the unified files store
        useFilesStore.getState().navigateToPath('.');
        
        set({
          activeView: 'tools',
          shouldOpenPanel: true,
        });
      },
      
      navigateToToolCall: (toolIndex: number) => {
        set({
          activeView: 'tools',
          pendingToolNavIndex: toolIndex,
          shouldOpenPanel: true,
        });
      },
      
      clearPendingToolNav: () => {
        set({ pendingToolNavIndex: null });
      },

      focusToolCall: (callId: string) => {
        const sessionId = get()._activeSessionId;
        const update: Partial<KortixComputerState> = {
          focusedToolCallId: callId,
          activeView: 'tools',
          isSidePanelOpen: true,
        };
        if (sessionId) {
          update._panelOpenBySession = {
            ...get()._panelOpenBySession,
            [sessionId]: true,
          };
        }
        set(update);
      },

      clearFocusedToolCall: () => {
        set({ focusedToolCallId: null });
      },
      
      clearShouldOpenPanel: () => {
        set({ shouldOpenPanel: false });
      },
      
      setIsSidePanelOpen: (open: boolean) => {
        const sessionId = get()._activeSessionId;
        const update: Partial<KortixComputerState> = { isSidePanelOpen: open };
        if (sessionId) {
          update._panelOpenBySession = { ...get()._panelOpenBySession, [sessionId]: open };
        }
        set(update);
      },

      setActiveSession: (sessionId: string | null) => {
        const prev = get()._activeSessionId;
        if (prev === sessionId) return;
        // Save current panel state for the previous session
        const panelMap = { ...get()._panelOpenBySession };
        if (prev) {
          panelMap[prev] = get().isSidePanelOpen;
        }
        // Restore panel state for the new session (default to false if unseen)
        const restored = sessionId ? (panelMap[sessionId] ?? false) : false;
        set({
          _activeSessionId: sessionId,
          _panelOpenBySession: panelMap,
          isSidePanelOpen: restored,
          // Reset expanded state when switching sessions
          isExpanded: false,
        });
      },
      
      openSidePanel: () => {
        const sessionId = get()._activeSessionId;
        const update: Partial<KortixComputerState> = { isSidePanelOpen: true };
        if (sessionId) {
          update._panelOpenBySession = { ...get()._panelOpenBySession, [sessionId]: true };
        }
        set(update);
      },
      
      closeSidePanel: () => {
        const sessionId = get()._activeSessionId;
        const update: Partial<KortixComputerState> = { isSidePanelOpen: false, isExpanded: false };
        if (sessionId) {
          update._panelOpenBySession = { ...get()._panelOpenBySession, [sessionId]: false };
        }
        set(update);
      },

      setIsExpanded: (expanded: boolean) => {
        set({ isExpanded: expanded });
      },

      toggleExpanded: () => {
        set((state) => ({ isExpanded: !state.isExpanded }));
      },
      
      reset: () => {
        useFilesStore.getState().reset();
        set(initialState);
      },
    }),
    {
      name: 'kortix-computer-store',
    }
  )
);

// === SELECTOR HOOKS ===

// Side-panel Actions focus (clicking a tool call in chat)
export const useFocusedToolCallId = () =>
  useKortixComputerStore((state) => state.focusedToolCallId);

export const useClearFocusedToolCall = () =>
  useKortixComputerStore((state) => state.clearFocusedToolCall);
