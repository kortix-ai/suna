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
} from '@/features/file-browser/types';

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

// Pure path heuristics
export { hasFileExtension } from './path-utils';

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
export { useWorkspaceSearch } from './hooks/use-workspace-search';

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
} from '@/features/file-browser/store/files-store';

// Explorer source (the shared Drive explorer UI lives in features/project-files)
export { sandboxExplorerSource } from './sandbox-explorer-source';
