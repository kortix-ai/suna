import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { HIDE_BROWSER_TAB } from '@/components/thread/utils';

export type ViewType = 'tools' | 'files' | 'browser';
export type FilesSubView = 'browser' | 'viewer';

/**
 * Normalize a file path to ensure it starts with /workspace
 * Handles paths like "workspace", "workspace/foo", "/workspace", "/workspace/foo", "/foo", "foo"
 */
function normalizeWorkspacePath(path: string): string {
  if (!path) return '/workspace';
  
  // Handle paths that start with "workspace" (without leading /)
  // This prevents "/workspace/workspace" when someone passes "workspace" or "workspace/foo"
  if (path === 'workspace' || path.startsWith('workspace/')) {
    return '/' + path;
  }
  
  // If already starts with /workspace, return as-is
  if (path.startsWith('/workspace')) {
    return path;
  }
  
  // Otherwise, prepend /workspace/
  return `/workspace/${path.replace(/^\//, '')}`;
}

interface KortixComputerState {
  // === SANDBOX CONTEXT ===
  // Track which sandbox the current file state belongs to
  // This is the KEY to preventing stale state across thread switches
  currentSandboxId: string | null;
  
  // Main view state
  activeView: ViewType;
  
  // Files view state
  filesSubView: FilesSubView;
  currentPath: string;
  selectedFilePath: string | null;
  filePathList: string[] | undefined;
  currentFileIndex: number;
  
  // Version history state (shared across file browser and viewer)
  selectedVersion: string | null;
  selectedVersionDate: string | null;
  
  // Panel state
  shouldOpenPanel: boolean;
  isSidePanelOpen: boolean;
  
  // Tool navigation state (for external tool click triggers)
  pendingToolNavIndex: number | null;
  
  // Unsaved file content persistence (keyed by sandboxId:filePath)
  unsavedFileContent: Record<string, string>;
  // Unsaved state tracking (has user made edits?)
  unsavedFileState: Record<string, boolean>;
  
  // === ACTIONS ===
  
  // Set the current sandbox context - MUST be called when thread/sandbox changes
  // This will clear file state if sandbox changed
  setSandboxContext: (sandboxId: string | null) => void;
  
  setActiveView: (view: ViewType) => void;
  
  // File browser actions
  openFile: (filePath: string, filePathList?: string[]) => void;
  goBackToBrowser: () => void;
  navigateToPath: (path: string) => void;
  setCurrentFileIndex: (index: number) => void;
  
  // Version history actions
  setSelectedVersion: (commit: string | null, date?: string | null) => void;
  clearSelectedVersion: () => void;
  
  // For external triggers (clicking file in chat)
  openFileInComputer: (filePath: string, filePathList?: string[]) => void;
  
  // Open files browser without selecting a file
  openFileBrowser: () => void;
  
  // Navigate to a specific tool call (clicking tool in ThreadContent)
  navigateToToolCall: (toolIndex: number) => void;
  
  // Clear pending tool nav after KortixComputer processes it
  clearPendingToolNav: () => void;
  
  // Panel control
  clearShouldOpenPanel: () => void;
  setIsSidePanelOpen: (open: boolean) => void;
  openSidePanel: () => void;
  closeSidePanel: () => void;
  
  // Unsaved content management
  setUnsavedContent: (filePath: string, content: string) => void;
  getUnsavedContent: (filePath: string) => string | undefined;
  clearUnsavedContent: (filePath: string) => void;
  
  // Unsaved state management (tracks if user has made edits)
  setUnsavedState: (filePath: string, hasUnsaved: boolean) => void;
  getUnsavedState: (filePath: string) => boolean;
  
  // Reset all state (full reset)
  reset: () => void;
  
  // Clear only file-related state (keeps panel state)
  clearFileState: () => void;
}

// Initial state for file-related fields only
const initialFileState = {
  filesSubView: 'browser' as FilesSubView,
  currentPath: '/workspace',
  selectedFilePath: null as string | null,
  filePathList: undefined as string[] | undefined,
  currentFileIndex: -1,
  selectedVersion: null as string | null,
  selectedVersionDate: null as string | null,
};

const initialState = {
  currentSandboxId: null as string | null,
  activeView: 'tools' as ViewType,
  ...initialFileState,
  shouldOpenPanel: false,
  isSidePanelOpen: false,
  pendingToolNavIndex: null as number | null,
  unsavedFileContent: {} as Record<string, string>,
  unsavedFileState: {} as Record<string, boolean>,
};

export const useKortixComputerStore = create<KortixComputerState>()(
  devtools(
    (set, get) => ({
      ...initialState,
      
      // === SANDBOX CONTEXT MANAGEMENT ===
      // This is the primary mechanism for handling thread/sandbox switches
      setSandboxContext: (sandboxId: string | null) => {
        const currentSandboxId = get().currentSandboxId;
        
        // If sandbox changed, clear all file-related state
        if (currentSandboxId !== sandboxId) {
          console.log('[KortixComputerStore] Sandbox context changed:', currentSandboxId, '->', sandboxId);
          set({
            currentSandboxId: sandboxId,
            // Reset all file state when sandbox changes
            ...initialFileState,
            activeView: 'tools', // Also reset to tools view
          });
        }
      },
      
      clearFileState: () => {
        console.log('[KortixComputerStore] Clearing file state');
        set({
          ...initialFileState,
        });
      },
      
      setActiveView: (view: ViewType) => {
        // If browser tab is hidden and trying to set browser view, default to tools
        const effectiveView = HIDE_BROWSER_TAB && view === 'browser' ? 'tools' : view;
        
        // Clear file selection when switching away from files view
        if (effectiveView !== 'files') {
          set({ 
            activeView: effectiveView,
            selectedFilePath: null,
            filePathList: undefined,
            currentFileIndex: -1,
          });
        } else {
          set({ activeView: effectiveView });
        }
      },
      
      openFile: (filePath: string, filePathList?: string[]) => {
        // Normalize the file path
        const normalizedPath = normalizeWorkspacePath(filePath);
        
        // Extract directory from file path for breadcrumb context
        const lastSlashIndex = normalizedPath.lastIndexOf('/');
        const directoryPath = lastSlashIndex > 0
          ? normalizedPath.substring(0, lastSlashIndex)
          : '/workspace';
        
        // Find index in filePathList if provided
        let fileIndex = -1;
        if (filePathList && filePathList.length > 0) {
          fileIndex = filePathList.findIndex(path => {
            const normalizedListPath = normalizeWorkspacePath(path);
            return normalizedListPath === normalizedPath;
          });
        }
        
        set({
          filesSubView: 'viewer',
          selectedFilePath: normalizedPath,
          currentPath: directoryPath,
          filePathList: filePathList,
          currentFileIndex: fileIndex >= 0 ? fileIndex : 0,
        });
      },
      
      goBackToBrowser: () => {
        set({
          filesSubView: 'browser',
          selectedFilePath: null,
          filePathList: undefined,
          currentFileIndex: -1,
        });
      },
      
      navigateToPath: (path: string) => {
        const normalizedPath = normalizeWorkspacePath(path);
        
        set({
          currentPath: normalizedPath,
          filesSubView: 'browser',
          selectedFilePath: null,
          filePathList: undefined,
          currentFileIndex: -1,
        });
      },
      
      setCurrentFileIndex: (index: number) => {
        const { filePathList } = get();
        if (filePathList && index >= 0 && index < filePathList.length) {
          const filePath = filePathList[index];
          const normalizedPath = normalizeWorkspacePath(filePath);
          
          set({
            currentFileIndex: index,
            selectedFilePath: normalizedPath,
          });
        }
      },
      
      setSelectedVersion: (commit: string | null, date?: string | null) => {
        set({
          selectedVersion: commit,
          selectedVersionDate: date ?? null,
        });
      },
      
      clearSelectedVersion: () => {
        set({
          selectedVersion: null,
          selectedVersionDate: null,
        });
      },
      
      openFileInComputer: (filePath: string, filePathList?: string[]) => {
        // This is called from external sources (clicking file in chat)
        // It should open the panel, switch to files view, and show the file
        const normalizedPath = normalizeWorkspacePath(filePath);
        
        const lastSlashIndex = normalizedPath.lastIndexOf('/');
        const directoryPath = lastSlashIndex > 0
          ? normalizedPath.substring(0, lastSlashIndex)
          : '/workspace';
        
        let fileIndex = -1;
        if (filePathList && filePathList.length > 0) {
          fileIndex = filePathList.findIndex(path => {
            const normalizedListPath = normalizeWorkspacePath(path);
            return normalizedListPath === normalizedPath;
          });
        }
        
        set({
          activeView: 'files',
          filesSubView: 'viewer',
          selectedFilePath: normalizedPath,
          currentPath: directoryPath,
          filePathList: filePathList,
          currentFileIndex: fileIndex >= 0 ? fileIndex : 0,
          shouldOpenPanel: true,
        });
      },
      
      openFileBrowser: () => {
        // Open files tab in browser mode without selecting a file
        set({
          activeView: 'files',
          filesSubView: 'browser',
          currentPath: '/workspace',
          selectedFilePath: null,
          filePathList: undefined,
          currentFileIndex: -1,
          shouldOpenPanel: true,
        });
      },
      
      navigateToToolCall: (toolIndex: number) => {
        // Navigate to a specific tool call - switch to tools view and set pending nav
        set({
          activeView: 'tools',
          pendingToolNavIndex: toolIndex,
          shouldOpenPanel: true,
        });
      },
      
      clearPendingToolNav: () => {
        set({ pendingToolNavIndex: null });
      },
      
      clearShouldOpenPanel: () => {
        set({ shouldOpenPanel: false });
      },
      
      setIsSidePanelOpen: (open: boolean) => {
        set({ isSidePanelOpen: open });
      },
      
      openSidePanel: () => {
        set({ isSidePanelOpen: true });
      },
      
      closeSidePanel: () => {
        set({ isSidePanelOpen: false });
      },
      
      setUnsavedContent: (filePath: string, content: string) => {
        const { currentSandboxId } = get();
        if (!currentSandboxId) return;
        
        const normalizedPath = normalizeWorkspacePath(filePath);
        const key = `${currentSandboxId}:${normalizedPath}`;
        set((state) => ({
          unsavedFileContent: {
            ...state.unsavedFileContent,
            [key]: content,
          },
        }));
      },
      
      getUnsavedContent: (filePath: string) => {
        const { currentSandboxId, unsavedFileContent } = get();
        if (!currentSandboxId) return undefined;
        
        const normalizedPath = normalizeWorkspacePath(filePath);
        const key = `${currentSandboxId}:${normalizedPath}`;
        return unsavedFileContent[key];
      },
      
      clearUnsavedContent: (filePath: string) => {
        const { currentSandboxId } = get();
        if (!currentSandboxId) return;
        
        const normalizedPath = normalizeWorkspacePath(filePath);
        const key = `${currentSandboxId}:${normalizedPath}`;
        set((state) => {
          const { [key]: _, ...restContent } = state.unsavedFileContent;
          const { [key]: __, ...restState } = state.unsavedFileState;
          return { 
            unsavedFileContent: restContent,
            unsavedFileState: restState,
          };
        });
      },
      
      setUnsavedState: (filePath: string, hasUnsaved: boolean) => {
        const { currentSandboxId } = get();
        if (!currentSandboxId) return;
        
        const normalizedPath = normalizeWorkspacePath(filePath);
        const key = `${currentSandboxId}:${normalizedPath}`;
        set((state) => ({
          unsavedFileState: {
            ...state.unsavedFileState,
            [key]: hasUnsaved,
          },
        }));
      },
      
      getUnsavedState: (filePath: string) => {
        const { currentSandboxId, unsavedFileState } = get();
        if (!currentSandboxId) return false;
        
        const normalizedPath = normalizeWorkspacePath(filePath);
        const key = `${currentSandboxId}:${normalizedPath}`;
        return unsavedFileState[key] ?? false;
      },
      
      reset: () => {
        console.log('[KortixComputerStore] Full reset');
        set(initialState);
      },
    }),
    {
      name: 'kortix-computer-store',
    }
  )
);

// === SELECTOR HOOKS ===

// Sandbox context
export const useKortixComputerSandboxId = () =>
  useKortixComputerStore((state) => state.currentSandboxId);

export const useSetSandboxContext = () =>
  useKortixComputerStore((state) => state.setSandboxContext);

// Main view state
export const useKortixComputerActiveView = () => 
  useKortixComputerStore((state) => state.activeView);

// Individual selectors for files state (stable, primitive values)
export const useKortixComputerFilesSubView = () =>
  useKortixComputerStore((state) => state.filesSubView);

export const useKortixComputerCurrentPath = () =>
  useKortixComputerStore((state) => state.currentPath);

export const useKortixComputerSelectedFilePath = () =>
  useKortixComputerStore((state) => state.selectedFilePath);

export const useKortixComputerFilePathList = () =>
  useKortixComputerStore((state) => state.filePathList);

export const useKortixComputerCurrentFileIndex = () =>
  useKortixComputerStore((state) => state.currentFileIndex);

// Legacy combined selector (for backward compatibility) - use individual selectors in components
export const useKortixComputerFilesState = () => ({
  filesSubView: useKortixComputerStore((state) => state.filesSubView),
  currentPath: useKortixComputerStore((state) => state.currentPath),
  selectedFilePath: useKortixComputerStore((state) => state.selectedFilePath),
  filePathList: useKortixComputerStore((state) => state.filePathList),
  currentFileIndex: useKortixComputerStore((state) => state.currentFileIndex),
});

// Actions are stable references (functions don't change)
export const useKortixComputerActions = () =>
  useKortixComputerStore((state) => ({
    setActiveView: state.setActiveView,
    openFile: state.openFile,
    goBackToBrowser: state.goBackToBrowser,
    navigateToPath: state.navigateToPath,
    setCurrentFileIndex: state.setCurrentFileIndex,
    openFileInComputer: state.openFileInComputer,
    openFileBrowser: state.openFileBrowser,
    navigateToToolCall: state.navigateToToolCall,
    clearPendingToolNav: state.clearPendingToolNav,
    clearShouldOpenPanel: state.clearShouldOpenPanel,
    setSandboxContext: state.setSandboxContext,
    clearFileState: state.clearFileState,
    reset: state.reset,
  }));

// Individual selectors for pending tool navigation (stable primitives)
export const useKortixComputerPendingToolNavIndex = () =>
  useKortixComputerStore((state) => state.pendingToolNavIndex);

export const useKortixComputerClearPendingToolNav = () =>
  useKortixComputerStore((state) => state.clearPendingToolNav);

// Side panel state selectors
export const useIsSidePanelOpen = () =>
  useKortixComputerStore((state) => state.isSidePanelOpen);

export const useSetIsSidePanelOpen = () =>
  useKortixComputerStore((state) => state.setIsSidePanelOpen);
