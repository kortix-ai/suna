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

// Explorer source injection (shared Drive explorer, per-surface data access)
export {
  FileExplorerSourceProvider,
  useFileExplorerSource,
  type ExplorerCapabilities,
  type FileExplorerSource,
} from './explorer-source';
export { gitRefExplorerSource } from './git-ref-explorer-source';

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
  fileListKeys,
  fileContentKeys,
  fileSearchKeys,
  fileHistoryKeys,
} from './hooks';

// Standalone workspace file search (mirrors files feature surface)
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
} from '@/features/file-browser/store/files-store';

// Per-project Version selection
export { useVersionStore, useSelectedVersion } from './store/version-store';

// Components
export {
  DriveExplorer,
  FileContentRenderer,
  FileSearch,
  FileBreadcrumbs,
  FilePathBreadcrumbs,
  FileTreeItem,
  FileThumbnail,
  FileExplorerPage,
  VersionSelector,
  CheckpointsPanel,
  getFileCategory,
  getFileIcon,
  getLanguageFromExt,
} from './components';
export type { FileContentRendererProps } from './components';
