/**
 * Files feature — OpenCode server filesystem browsing.
 *
 * This module replaces the entire legacy sandbox-based file system.
 * All file operations go directly to the active OpenCode server.
 */

// Types
export type {
  FileCommitDiff,
  FileContent,
  FileHistoryResult,
  FileNode,
  FilePatch,
  FilePatchHunk,
  FindMatch,
  GitCommit,
  LssHit,
  LssSearchResult,
  RuntimeProjectInfo,
  ServerHealth,
} from '../../internal/files/types';

// API — read
export {
  copyFile,
  createFile,
  deleteFile,
  downloadFile,
  findFiles,
  findText,
  getCurrentProject,
  getServerHealth,
  isServerReachable,
  listFiles,
  mkdirFile,
  readFile,
  // binary helpers
  readFileAsBlob,
  renameFile,
  // write
  uploadFile,
  type UploadResult,
} from '../../internal/files/runtime-files';

// Pure path heuristics
export { hasFileExtension } from './path-utils';

// API — git history
export { getFileAtCommit, getFileCommitDiff, getFileHistory } from '../../internal/files/git-history';

// Hooks
export {
  fileContentKeys,
  fileHistoryKeys,
  fileListKeys,
  fileSearchKeys,
  useCurrentProject,
  useFileAtCommit,
  useFileCommitDiff,
  useFileContent,
  useFileCopy,
  useFileCreate,
  useFileDelete,
  useFileEventInvalidation,
  useFileHistory,
  useFileList,
  useFileMkdir,
  useFileRename,
  useFileSearch,
  useFileUpload,
  useInvalidateFileContent,
  useInvalidateFileList,
  useServerHealth,
} from './hooks';

// Standalone workspace file search (CMD+K, @-mentions, etc.)
export { useWorkspaceSearch } from './hooks/use-workspace-search';
export { searchWorkspaceFiles } from './search/workspace-search-service';

// Store
export {
  FilesStoreProvider,
  createFilesStore,
  globalFilesStore,
  useFilesStore,
  useFilesStoreApi,
  type ClipboardItem,
  type ClipboardOperation,
  type FilesStore,
  type FilesStoreApi,
  type FilesView,
} from '../../internal/stores/files-store';

// Explorer source (the shared Drive explorer UI lives in packages/ui/src/files/project)
export { sandboxExplorerSource } from './sandbox-explorer-source';
