import { create } from 'zustand';

export type ViewType = 'tools' | 'files' | 'browser';
export type FilesSubView = 'browser' | 'viewer';

interface KortixComputerState {
  // Main view state
  activeView: ViewType;
  
  // Files view state
  filesSubView: FilesSubView;
  currentPath: string;
  selectedFilePath: string | null;
  filePathList: string[] | undefined;
  currentFileIndex: number;
  
  // Panel state
  isOpen: boolean;
  
  // Tool navigation state (for external tool click triggers)
  pendingToolNavIndex: number | null;
  
  // Unsaved file content persistence
  unsavedFileContent: Record<string, string>;
  // Unsaved state tracking (has user made edits?)
  unsavedFileState: Record<string, boolean>;
  
  // Actions
  setActiveView: (view: ViewType) => void;
  
  // File browser actions
  openFile: (filePath: string, filePathList?: string[]) => void;
  goBackToBrowser: () => void;
  navigateToPath: (path: string) => void;
  setCurrentFileIndex: (index: number) => void;
  
  // For external triggers (clicking file in chat)
  openFileInComputer: (filePath: string, filePathList?: string[]) => void;
  
  // Open files browser without selecting a file
  openFileBrowser: () => void;
  
  // Navigate to a specific tool call (clicking tool in ThreadContent)
  navigateToToolCall: (toolIndex: number) => void;
  
  // Clear pending tool nav after KortixComputer processes it
  clearPendingToolNav: () => void;
  
  // Panel control
  openPanel: () => void;
  closePanel: () => void;
  
  // Unsaved content management
  setUnsavedContent: (filePath: string, content: string) => void;
  getUnsavedContent: (filePath: string) => string | undefined;
  clearUnsavedContent: (filePath: string) => void;
  
  // Unsaved state management (tracks if user has made edits)
  setUnsavedState: (filePath: string, hasUnsaved: boolean) => void;
  getUnsavedState: (filePath: string) => boolean;
  
  // Reset state
  reset: () => void;
}

const initialState = {
  activeView: 'tools' as ViewType,
  filesSubView: 'browser' as FilesSubView,
  currentPath: '/workspace',
  selectedFilePath: null,
  filePathList: undefined,
  currentFileIndex: -1,
  isOpen: false,
  pendingToolNavIndex: null as number | null,
  unsavedFileContent: {} as Record<string, string>,
  unsavedFileState: {} as Record<string, boolean>,
};

export const useKortixComputerStore = create<KortixComputerState>((set, get) => ({
  ...initialState,
  
  setActiveView: (view: ViewType) => {
    set({ activeView: view });
  },
  
  openFile: (filePath: string, filePathList?: string[]) => {
    // Normalize the file path
    const normalizedPath = filePath.startsWith('/workspace')
      ? filePath
      : `/workspace/${filePath.replace(/^\//, '')}`;
    
    // Extract directory from file path for breadcrumb context
    const lastSlashIndex = normalizedPath.lastIndexOf('/');
    const directoryPath = lastSlashIndex > 0
      ? normalizedPath.substring(0, lastSlashIndex)
      : '/workspace';
    
    // Find index in filePathList if provided
    let fileIndex = -1;
    if (filePathList && filePathList.length > 0) {
      fileIndex = filePathList.findIndex(path => {
        const normalizedListPath = path.startsWith('/workspace')
          ? path
          : `/workspace/${path.replace(/^\//, '')}`;
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
    const normalizedPath = path.startsWith('/workspace')
      ? path
      : `/workspace/${path.replace(/^\//, '')}`;
    
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
      const normalizedPath = filePath.startsWith('/workspace')
        ? filePath
        : `/workspace/${filePath.replace(/^\//, '')}`;
      
      set({
        currentFileIndex: index,
        selectedFilePath: normalizedPath,
      });
    }
  },
  
  openFileInComputer: (filePath: string, filePathList?: string[]) => {
    // This is called from external sources (clicking file in chat)
    // It should open the panel, switch to files view, and show the file
    const normalizedPath = filePath.startsWith('/workspace')
      ? filePath
      : `/workspace/${filePath.replace(/^\//, '')}`;
    
    const lastSlashIndex = normalizedPath.lastIndexOf('/');
    const directoryPath = lastSlashIndex > 0
      ? normalizedPath.substring(0, lastSlashIndex)
      : '/workspace';
    
    let fileIndex = -1;
    if (filePathList && filePathList.length > 0) {
      fileIndex = filePathList.findIndex(path => {
        const normalizedListPath = path.startsWith('/workspace')
          ? path
          : `/workspace/${path.replace(/^\//, '')}`;
        return normalizedListPath === normalizedPath;
      });
    }
    
    set({
      isOpen: true,
      activeView: 'files',
      filesSubView: 'viewer',
      selectedFilePath: normalizedPath,
      currentPath: directoryPath,
      filePathList: filePathList,
      currentFileIndex: fileIndex >= 0 ? fileIndex : 0,
    });
  },
  
  openFileBrowser: () => {
    // Open files tab in browser mode without selecting a file
    set({
      isOpen: true,
      activeView: 'files',
      filesSubView: 'browser',
      currentPath: '/workspace',
      selectedFilePath: null,
      filePathList: undefined,
      currentFileIndex: -1,
    });
  },
  
  navigateToToolCall: (toolIndex: number) => {
    // Navigate to a specific tool call - switch to tools view and set pending nav
    set({
      isOpen: true,
      activeView: 'tools',
      pendingToolNavIndex: toolIndex,
    });
  },
  
  clearPendingToolNav: () => {
    set({ pendingToolNavIndex: null });
  },
  
  openPanel: () => {
    set({ isOpen: true });
  },
  
  closePanel: () => {
    set({ isOpen: false });
  },
  
  setUnsavedContent: (filePath: string, content: string) => {
    const normalizedPath = filePath.startsWith('/workspace')
      ? filePath
      : `/workspace/${filePath.replace(/^\//, '')}`;
    set((state) => ({
      unsavedFileContent: {
        ...state.unsavedFileContent,
        [normalizedPath]: content,
      },
    }));
  },
  
  getUnsavedContent: (filePath: string) => {
    const normalizedPath = filePath.startsWith('/workspace')
      ? filePath
      : `/workspace/${filePath.replace(/^\//, '')}`;
    return get().unsavedFileContent[normalizedPath];
  },
  
  clearUnsavedContent: (filePath: string) => {
    const normalizedPath = filePath.startsWith('/workspace')
      ? filePath
      : `/workspace/${filePath.replace(/^\//, '')}`;
    set((state) => {
      const { [normalizedPath]: _, ...restContent } = state.unsavedFileContent;
      const { [normalizedPath]: __, ...restState } = state.unsavedFileState;
      return { 
        unsavedFileContent: restContent,
        unsavedFileState: restState,
      };
    });
  },
  
  setUnsavedState: (filePath: string, hasUnsaved: boolean) => {
    const normalizedPath = filePath.startsWith('/workspace')
      ? filePath
      : `/workspace/${filePath.replace(/^\//, '')}`;
    set((state) => ({
      unsavedFileState: {
        ...state.unsavedFileState,
        [normalizedPath]: hasUnsaved,
      },
    }));
  },
  
  getUnsavedState: (filePath: string) => {
    const normalizedPath = filePath.startsWith('/workspace')
      ? filePath
      : `/workspace/${filePath.replace(/^\//, '')}`;
    return get().unsavedFileState[normalizedPath] ?? false;
  },
  
  reset: () => {
    set(initialState);
  },
}));

// Selector hooks for common use cases
export const useKortixComputerActiveView = () => 
  useKortixComputerStore((state) => state.activeView);

export const useKortixComputerIsOpen = () =>
  useKortixComputerStore((state) => state.isOpen);

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

// Individual selectors for pending tool navigation (stable primitives)
export const useKortixComputerPendingToolNavIndex = () =>
  useKortixComputerStore((state) => state.pendingToolNavIndex);

export const useKortixComputerClearPendingToolNav = () =>
  useKortixComputerStore((state) => state.clearPendingToolNav);

