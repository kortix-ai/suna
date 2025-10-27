import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
}

export interface FileBrowserState {
  // Modal state
  isVisible: boolean;
  sandboxId: string | null;
  initialPath: string | null;
  
  // Navigation state
  currentPath: string;
  selectedFile: FileItem | null;
  
  // UI state
  isLoading: boolean;
  error: string | null;
  
  // Actions
  openBrowser: (sandboxId: string, initialPath?: string) => void;
  closeBrowser: () => void;
  navigateTo: (path: string) => void;
  selectFile: (file: FileItem | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState = {
  isVisible: false,
  sandboxId: null,
  initialPath: null,
  currentPath: '/workspace',
  selectedFile: null,
  isLoading: false,
  error: null,
};

// Helper to determine if a path is likely a file (has extension)
const isFilePath = (path: string): boolean => {
  const lastPart = path.split('/').pop() || '';
  return lastPart.includes('.') && !lastPart.endsWith('/');
};

// Helper to get directory path from file path
const getDirectoryPath = (filePath: string): string => {
  const parts = filePath.split('/');
  return parts.slice(0, -1).join('/') || '/workspace';
};

// Helper to create file item from path
const createFileItemFromPath = (filePath: string): FileItem => {
  const fileName = filePath.split('/').pop() || '';
  return {
    name: fileName,
    path: filePath,
    isDirectory: false,
    size: undefined,
    modifiedAt: undefined,
  };
};

export const useFileBrowserStore = create<FileBrowserState>()(
  subscribeWithSelector((set, get) => ({
    ...initialState,
    
    openBrowser: (sandboxId, initialPath) => {
      if (initialPath && isFilePath(initialPath)) {
        // If opening with a file path, set directory and select the file
        const directoryPath = getDirectoryPath(initialPath);
        const fileItem = createFileItemFromPath(initialPath);
        
        set({
          isVisible: true,
          sandboxId,
          initialPath,
          currentPath: directoryPath,
          selectedFile: fileItem,
          error: null,
        });
      } else {
        // If opening with a directory path or no path
        set({
          isVisible: true,
          sandboxId,
          initialPath: initialPath || null,
          currentPath: initialPath || '/workspace',
          selectedFile: null,
          error: null,
        });
      }
    },
    
    closeBrowser: () => set(initialState),
    
    navigateTo: (path) => set({
      currentPath: path,
      selectedFile: null,
      error: null,
    }),
    
    selectFile: (file) => set({ selectedFile: file }),
    
    setLoading: (loading) => set({ isLoading: loading }),
    
    setError: (error) => set({ error }),
    
    reset: () => set(initialState),
  }))
);

// Selectors
export const useFileBrowserVisible = () => useFileBrowserStore((state) => state.isVisible);
export const useFileBrowserSandboxId = () => useFileBrowserStore((state) => state.sandboxId);
export const useFileBrowserCurrentPath = () => useFileBrowserStore((state) => state.currentPath);
export const useFileBrowserSelectedFile = () => useFileBrowserStore((state) => state.selectedFile);
export const useFileBrowserLoading = () => useFileBrowserStore((state) => state.isLoading);
export const useFileBrowserError = () => useFileBrowserStore((state) => state.error);

// Actions
export const useOpenFileBrowser = () => useFileBrowserStore((state) => state.openBrowser);
export const useCloseFileBrowser = () => useFileBrowserStore((state) => state.closeBrowser);
export const useNavigateToPath = () => useFileBrowserStore((state) => state.navigateTo);
export const useSelectFile = () => useFileBrowserStore((state) => state.selectFile);
export const useSetFileBrowserLoading = () => useFileBrowserStore((state) => state.setLoading);
export const useSetFileBrowserError = () => useFileBrowserStore((state) => state.setError); 