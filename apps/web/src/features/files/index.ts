/**
 * Files feature — OpenCode server filesystem browsing.
 *
 * This module replaces the entire legacy sandbox-based file system.
 * All file operations go directly to the active OpenCode server.
 */

// Types
export type {
  FileNode,
  FileContent,
  FilePatch,
  FilePatchHunk,
  FindMatch,
  LssHit,
  LssSearchResult,
  OpenCodeProjectInfo,
  ServerHealth,
  GitCommit,
  FileHistoryResult,
  FileCommitDiff,
} from './types';

// API — read
export {
  listFiles,
  readFile,
  findFiles,
  findText,
  getCurrentProject,
  getServerHealth,
  isServerReachable,
  // binary helpers
  readFileAsBlob,
  downloadFile,
  // write
  uploadFile,
  deleteFile,
  mkdirFile,
  renameFile,
  createFile,
  copyFile,
  type UploadResult,
} from './api/opencode-files';

// API — semantic search (LSS)
export { searchLss } from './api/lss-search';

// API — git history
export { getFileHistory, getFileCommitDiff, getFileAtCommit } from './api/git-history';

// Hooks
export {
  useFileList,
  useInvalidateFileList,
  useFileContent,
  useInvalidateFileContent,
  useFileSearch,
  useServerHealth,
  useCurrentProject,
  useFileEventInvalidation,
  useFileUpload,
  useFileDelete,
  useFileMkdir,
  useFileRename,
  useFileCreate,
  useFileCopy,
  useFileHistory,
  useFileCommitDiff,
  useFileAtCommit,
  fileListKeys,
  fileContentKeys,
  fileSearchKeys,
  fileHistoryKeys,
} from './hooks';

// Standalone workspace file search (CMD+K, @-mentions, etc.)
export { searchWorkspaceFiles } from './search/workspace-search-service';

// Store
export {
  createFilesStore,
  FilesStoreProvider,
  globalFilesStore,
  useFilesStore,
  useFilesStoreApi,
  type FilesView,
  type ClipboardOperation,
  type ClipboardItem,
  type FilesStore,
  type FilesStoreApi,
} from './store/files-store';

// Components
export {
  FileBrowser,
  FileViewer,
  FileContentRenderer,
  FileSearch,
  FileBreadcrumbs,
  FileTreeItem,
  FileHistoryPanel,
  FileTree,
  FileExplorerPage,
  FileExplorerToolbar,
  FileExplorerStatusBar,
  getFileCategory,
  getLanguageFromExt,
} from './components';
export type { FileContentRendererProps } from './components';
