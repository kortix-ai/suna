import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

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
  shouldOpenPanel: boolean;
  
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
  
  // Panel control
  clearShouldOpenPanel: () => void;
  
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
  shouldOpenPanel: false,
};

export const useKortixComputerStore = create<KortixComputerState>()(
  devtools(
    (set, get) => ({
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
      
      clearShouldOpenPanel: () => {
        set({ shouldOpenPanel: false });
      },
      
      reset: () => {
        set(initialState);
      },
    }),
    {
      name: 'kortix-computer-store',
    }
  )
);

// Selector hooks for common use cases
export const useKortixComputerActiveView = () => 
  useKortixComputerStore((state) => state.activeView);

export const useKortixComputerFilesState = () => 
  useKortixComputerStore((state) => ({
    filesSubView: state.filesSubView,
    currentPath: state.currentPath,
    selectedFilePath: state.selectedFilePath,
    filePathList: state.filePathList,
    currentFileIndex: state.currentFileIndex,
  }));

export const useKortixComputerActions = () =>
  useKortixComputerStore((state) => ({
    setActiveView: state.setActiveView,
    openFile: state.openFile,
    goBackToBrowser: state.goBackToBrowser,
    navigateToPath: state.navigateToPath,
    setCurrentFileIndex: state.setCurrentFileIndex,
    openFileInComputer: state.openFileInComputer,
    openFileBrowser: state.openFileBrowser,
    clearShouldOpenPanel: state.clearShouldOpenPanel,
    reset: state.reset,
  }));

