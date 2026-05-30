'use client';

import { createContext, createElement, useContext, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type FilesView = 'browser' | 'viewer' | 'history';
export type ViewMode = 'grid' | 'list';
export type SortField = 'name' | 'modified' | 'size' | 'type';
export type SortOrder = 'asc' | 'desc';

/** Clipboard operation type for copy/cut */
export type ClipboardOperation = 'copy' | 'cut';

/** Clipboard item representing a file or directory */
export interface ClipboardItem {
  /** Relative path of the item */
  path: string;
  /** Name of the item */
  name: string;
  /** Whether it's a file or directory */
  type: 'file' | 'directory';
  /** The operation (copy or cut/move) */
  operation: ClipboardOperation;
}

interface FilesStoreState {
  /** Which view is active: directory browser or file viewer */
  view: FilesView;
  /** Current directory path being browsed (relative to project root) */
  currentPath: string;
  /** Path of the file currently being viewed (null = none selected) */
  selectedFilePath: string | null;
  /** Ordered list of file paths for prev/next navigation in viewer */
  filePathList: string[];
  /** Index into filePathList for current file */
  currentFileIndex: number;
  /** Whether the search overlay is open */
  isSearchOpen: boolean;
  /** Unsaved file content persistence (keyed by filePath) */
  unsavedFileContent: Record<string, string>;
  /** Unsaved state tracking (has user made edits?) */
  unsavedFileState: Record<string, boolean>;
  /** Path of the file whose history is being viewed */
  historyFilePath: string | null;
  /** Currently selected commit hash in the history panel */
  selectedCommitHash: string | null;
  /** Clipboard item for copy/cut operations */
  clipboard: ClipboardItem | null;
  /** Target line number to scroll to after opening a file (1-indexed, null = none) */
  targetLine: number | null;
  /** Whether to show hidden (dot) files and directories */
  showHidden: boolean;

  // ── Root path constraint ─────────────────────────────────────
  /** When set, navigation is constrained to this directory and its children */
  rootPath: string | null;

  // ── Google Drive view state ──────────────────────────────────
  /** Grid or list view mode */
  viewMode: ViewMode;
  /** Sort field */
  sortBy: SortField;
  /** Sort direction */
  sortOrder: SortOrder;

  // ── Explorer tree state ──────────────────────────────────────
  /** Set of expanded directory paths in the tree sidebar */
  expandedDirs: Set<string>;
  /** Whether the tree sidebar is collapsed */
  isSidebarCollapsed: boolean;
  /** Right panel mode: 'viewer' shows file, 'welcome' shows empty state */
  panelMode: 'welcome' | 'viewer' | 'history';
}

interface FilesStoreActions {
  /** Navigate to a directory */
  navigateToPath: (path: string) => void;
  /** Set a root path constraint — navigation cannot go above this directory */
  setRootPath: (path: string | null) => void;
  /** Open a file in the viewer */
  openFile: (filePath: string, targetLine?: number) => void;
  /** Open a file and set the navigation list */
  openFileWithList: (filePath: string, fileList: string[], index: number) => void;
  /** Clear the target line after the viewer has scrolled to it */
  clearTargetLine: () => void;
  /** Go back from viewer to browser */
  goBackToBrowser: () => void;
  /** Navigate to next file in the list */
  nextFile: () => void;
  /** Navigate to previous file in the list */
  prevFile: () => void;
  /** Toggle search overlay */
  toggleSearch: () => void;
  /** Close search overlay */
  closeSearch: () => void;
  /** Set unsaved content for a file */
  setUnsavedContent: (filePath: string, content: string) => void;
  /** Get unsaved content for a file */
  getUnsavedContent: (filePath: string) => string | undefined;
  /** Clear unsaved content for a file */
  clearUnsavedContent: (filePath: string) => void;
  /** Set unsaved state (has user made edits?) */
  setUnsavedState: (filePath: string, hasUnsaved: boolean) => void;
  /** Get unsaved state for a file */
  getUnsavedState: (filePath: string) => boolean;
  /** Open the history view for a file */
  openHistory: (filePath: string) => void;
  /** Select a commit in the history panel */
  selectCommit: (commitHash: string | null) => void;
  /** Close the history view (go back to viewer or browser) */
  closeHistory: () => void;
  /** Copy a file/directory to clipboard */
  copyToClipboard: (path: string, name: string, type: 'file' | 'directory') => void;
  /** Cut a file/directory to clipboard */
  cutToClipboard: (path: string, name: string, type: 'file' | 'directory') => void;
  /** Clear clipboard */
  clearClipboard: () => void;
  /** Reset all state */
  reset: () => void;

  // ── Explorer tree actions ────────────────────────────────────
  /** Toggle a directory's expanded state in the tree */
  toggleDir: (path: string) => void;
  /** Expand a directory in the tree */
  expandDir: (path: string) => void;
  /** Collapse a directory in the tree */
  collapseDir: (path: string) => void;
  /** Expand all ancestor directories for a given file path */
  revealPath: (filePath: string) => void;
  /** Toggle sidebar collapsed state */
  toggleSidebar: () => void;
  /** Set sidebar collapsed state */
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** Toggle hidden files visibility */
  toggleHidden: () => void;

  // ── Google Drive view actions ────────────────────────────────
  /** Set the view mode (grid or list) */
  setViewMode: (mode: ViewMode) => void;
  /** Toggle between grid and list view */
  toggleViewMode: () => void;
  /** Set the sort field */
  setSortBy: (field: SortField) => void;
  /** Set the sort order */
  setSortOrder: (order: SortOrder) => void;
  /** Toggle sort order between asc and desc */
  toggleSortOrder: () => void;
}

/** Check if a path is equal to or a descendant of the root */
function isWithinRoot(path: string, root: string): boolean {
  const normPath = path.replace(/\/+$/, '') || '/';
  const normRoot = root.replace(/\/+$/, '') || '/';
  return normPath === normRoot || normPath.startsWith(normRoot + '/');
}

export type FilesStore = FilesStoreState & FilesStoreActions;
export type FilesStoreApi = StoreApi<FilesStore>;

const initialState: FilesStoreState = {
  view: 'browser',
  currentPath: '/workspace',
  selectedFilePath: null,
  filePathList: [],
  currentFileIndex: 0,
  isSearchOpen: false,
  unsavedFileContent: {},
  unsavedFileState: {},
  historyFilePath: null,
  selectedCommitHash: null,
  clipboard: null,
  targetLine: null,
  showHidden: false,
  rootPath: null,
  viewMode: (typeof window !== 'undefined' ? localStorage.getItem('files-view-mode') as ViewMode : null) || 'grid',
  sortBy: (typeof window !== 'undefined' ? localStorage.getItem('files-sort-by') as SortField : null) || 'name',
  sortOrder: (typeof window !== 'undefined' ? localStorage.getItem('files-sort-order') as SortOrder : null) || 'asc',
  expandedDirs: new Set(['/workspace']),
  isSidebarCollapsed: false,
  panelMode: 'welcome',
};

export function createFilesStore(): FilesStoreApi {
  return createStore<FilesStore>()((set, get) => ({
    ...initialState,

  navigateToPath: (path: string) => {
    const { rootPath } = get();
    let normalized = path || '/workspace';
    // Clamp to rootPath when set — prevent escaping the project directory
    if (rootPath && !isWithinRoot(normalized, rootPath)) {
      normalized = rootPath;
    }
    set({
      currentPath: normalized,
      view: 'browser',
      selectedFilePath: null,
      panelMode: 'welcome',
    });
    // Auto-expand the target directory in tree (skip for root /)
    if (normalized !== '/') get().expandDir(normalized);
  },

  setRootPath: (path: string | null) => {
    set({ rootPath: path });
  },

  openFile: (filePath: string, targetLine?: number) => {
    // Don't change currentPath - keep user in their current folder
    // Just open the file in viewer and reveal it in the tree

    set({
      selectedFilePath: filePath,
      view: 'viewer',
      panelMode: 'viewer',
      filePathList: [filePath],
      currentFileIndex: 0,
      isSearchOpen: false,
      targetLine: targetLine ?? null,
      // REMOVED: currentPath: parentDir - don't jump to file's folder
    });
    // Reveal the file in the tree
    get().revealPath(filePath);
  },

  clearTargetLine: () => {
    set({ targetLine: null });
  },

  openFileWithList: (filePath: string, fileList: string[], index: number) => {
    // Don't change currentPath - keep user in their current folder

    set({
      selectedFilePath: filePath,
      view: 'viewer',
      panelMode: 'viewer',
      filePathList: fileList,
      currentFileIndex: index,
      isSearchOpen: false,
      // REMOVED: currentPath: parentDir - don't jump to file's folder
    });
    get().revealPath(filePath);
  },

  goBackToBrowser: () => {
    set({
      view: 'browser',
      panelMode: 'welcome',
      selectedFilePath: null,
    });
  },

  nextFile: () => {
    const { filePathList, currentFileIndex } = get();
    if (currentFileIndex < filePathList.length - 1) {
      const nextIndex = currentFileIndex + 1;
      set({
        currentFileIndex: nextIndex,
        selectedFilePath: filePathList[nextIndex],
      });
    }
  },

  prevFile: () => {
    const { filePathList, currentFileIndex } = get();
    if (currentFileIndex > 0) {
      const prevIndex = currentFileIndex - 1;
      set({
        currentFileIndex: prevIndex,
        selectedFilePath: filePathList[prevIndex],
      });
    }
  },

  toggleSearch: () => {
    set((s) => ({ isSearchOpen: !s.isSearchOpen }));
  },

  closeSearch: () => {
    set({ isSearchOpen: false });
  },

  setUnsavedContent: (filePath: string, content: string) => {
    set((state) => ({
      unsavedFileContent: {
        ...state.unsavedFileContent,
        [filePath]: content,
      },
    }));
  },

  getUnsavedContent: (filePath: string) => {
    return get().unsavedFileContent[filePath];
  },

  clearUnsavedContent: (filePath: string) => {
    set((state) => {
      const { [filePath]: _, ...restContent } = state.unsavedFileContent;
      const { [filePath]: __, ...restState } = state.unsavedFileState;
      return {
        unsavedFileContent: restContent,
        unsavedFileState: restState,
      };
    });
  },

  setUnsavedState: (filePath: string, hasUnsaved: boolean) => {
    set((state) => ({
      unsavedFileState: {
        ...state.unsavedFileState,
        [filePath]: hasUnsaved,
      },
    }));
  },

  getUnsavedState: (filePath: string) => {
    return get().unsavedFileState[filePath] ?? false;
  },

  openHistory: (filePath: string) => {
    set({
      view: 'history',
      panelMode: 'history',
      historyFilePath: filePath,
      selectedCommitHash: null,
      isSearchOpen: false,
    });
  },

  selectCommit: (commitHash: string | null) => {
    set({ selectedCommitHash: commitHash });
  },

  closeHistory: () => {
    const { selectedFilePath } = get();
    set({
      view: selectedFilePath ? 'viewer' : 'browser',
      panelMode: selectedFilePath ? 'viewer' : 'welcome',
      historyFilePath: null,
      selectedCommitHash: null,
    });
  },

  copyToClipboard: (path, name, type) => {
    set({ clipboard: { path, name, type, operation: 'copy' } });
  },

  cutToClipboard: (path, name, type) => {
    set({ clipboard: { path, name, type, operation: 'cut' } });
  },

  clearClipboard: () => {
    set({ clipboard: null });
  },

  reset: () => {
    set(initialState);
  },

  // ── Explorer tree actions ────────────────────────────────────

  toggleDir: (path: string) => {
    set((state) => {
      const next = new Set(state.expandedDirs);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { expandedDirs: next };
    });
  },

  expandDir: (path: string) => {
    set((state) => {
      if (state.expandedDirs.has(path)) return state;
      const next = new Set(state.expandedDirs);
      next.add(path);
      return { expandedDirs: next };
    });
  },

  collapseDir: (path: string) => {
    set((state) => {
      if (!state.expandedDirs.has(path)) return state;
      const next = new Set(state.expandedDirs);
      next.delete(path);
      return { expandedDirs: next };
    });
  },

  revealPath: (filePath: string) => {
    set((state) => {
      const next = new Set(state.expandedDirs);
      const parts = filePath.split('/');
      // Build ancestor paths and expand each
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join('/');
        if (ancestor) next.add(ancestor);
      }
      return { expandedDirs: next };
    });
  },

  toggleSidebar: () => {
    set((s) => ({ isSidebarCollapsed: !s.isSidebarCollapsed }));
  },

  setSidebarCollapsed: (collapsed: boolean) => {
    set({ isSidebarCollapsed: collapsed });
  },

  toggleHidden: () => {
    set((s) => ({ showHidden: !s.showHidden }));
  },

  // ── Google Drive view actions ────────────────────────────────

  setViewMode: (mode: ViewMode) => {
    set({ viewMode: mode });
    try { localStorage.setItem('files-view-mode', mode); } catch {}
  },

  toggleViewMode: () => {
    const next = get().viewMode === 'grid' ? 'list' : 'grid';
    set({ viewMode: next });
    try { localStorage.setItem('files-view-mode', next); } catch {}
  },

  setSortBy: (field: SortField) => {
    set({ sortBy: field });
    try { localStorage.setItem('files-sort-by', field); } catch {}
  },

  setSortOrder: (order: SortOrder) => {
    set({ sortOrder: order });
    try { localStorage.setItem('files-sort-order', order); } catch {}
  },

    toggleSortOrder: () => {
      const next = get().sortOrder === 'asc' ? 'desc' : 'asc';
      set({ sortOrder: next });
      try { localStorage.setItem('files-sort-order', next); } catch {}
    },
  }));
}

export const globalFilesStore = createFilesStore();

const FilesStoreContext = createContext<FilesStoreApi | null>(null);

type UseFilesStore = {
  <T>(selector: (state: FilesStore) => T): T;
  getState: FilesStoreApi['getState'];
  setState: FilesStoreApi['setState'];
  subscribe: FilesStoreApi['subscribe'];
};

export function FilesStoreProvider({
  children,
  store,
}: {
  children: ReactNode;
  store?: FilesStoreApi;
}) {
  const storeRef = useRef<FilesStoreApi>(store ?? createFilesStore());
  return createElement(FilesStoreContext.Provider, { value: storeRef.current }, children);
}

export const useFilesStore = Object.assign(
  function useFilesStore<T>(selector: (state: FilesStore) => T): T {
    const store = useContext(FilesStoreContext) ?? globalFilesStore;
    return useStore(store, selector);
  },
  {
    getState: globalFilesStore.getState,
    setState: globalFilesStore.setState,
    subscribe: globalFilesStore.subscribe,
  },
) as UseFilesStore;

export function useFilesStoreApi(): FilesStoreApi {
  return useContext(FilesStoreContext) ?? globalFilesStore;
}
