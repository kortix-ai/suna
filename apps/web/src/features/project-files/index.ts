/**
 * Project Files feature — read-only, git-backed.
 *
 * Mirrors the sandbox `features/files` module's public surface but every
 * data hook reads from `/v1/projects/:projectId/files` via React context.
 */

// Context
export {
  ProjectFilesContext,
  ProjectFilesProvider,
  useProjectContext,
  useProjectContextStrict,
  type ProjectFilesContextValue,
} from './context';

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

// API — branches (Versions) & whole-repo commits (Checkpoints)
export { fetchBranches } from './api/branches';
export { fetchCommits, fetchCommit, fetchCommitDiff } from './api/commits';

// Hooks
export {
  useFileList,
  useInvalidateFileList,
  useFileContent,
  useInvalidateFileContent,
  useFileSearch,
  useTextSearch,
  useLssSearch,
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
  useBranches,
  branchKeys,
  useCommits,
  useCommit,
  useCommitDiff,
  commitKeys,
  useWorkspaceSearch,
  searchWorkspaceFiles,
  rankFileResult,
  parseFileResults,
  fileListKeys,
  fileContentKeys,
  fileSearchKeys,
  fileHistoryKeys,
  lssSearchKeys,
} from './hooks';

export type {
  FileSearchResult,
  WorkspaceSearchState,
  UseWorkspaceSearchOptions,
} from './hooks';

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

// Per-project Version selection
export { useVersionStore, useSelectedVersion } from './store/version-store';

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
  VersionSelector,
  CheckpointsPanel,
  getFileCategory,
  getLanguageFromExt,
} from './components';
export type { FileContentRendererProps } from './components';
