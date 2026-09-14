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
} from '@/features/file-browser/types';

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
} from './api/runtime-files';

// API — git history
export { getFileAtCommit, getFileCommitDiff, getFileHistory } from './api/git-history';

// API — branches (Versions) & whole-repo commits (Checkpoints)
export { fetchBranches } from './api/branches';
export { fetchCommit, fetchCommitDiff, fetchCommits } from './api/commits';

// Hooks
export {
  branchKeys,
  commitKeys,
  fileContentKeys,
  fileHistoryKeys,
  fileListKeys,
  fileSearchKeys,
  useBranches,
  useCommit,
  useCommitDiff,
  useCommits,
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

// Standalone workspace file search (mirrors files feature surface)
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
} from '@/features/file-browser/store/files-store';

// Per-project Version selection
export { useSelectedVersion, useVersionStore } from './store/version-store';

// Components
export {
  CheckpointsPanel,
  DRIVE_ACTION_ROW_CLASS,
  DriveExplorer,
  FileBreadcrumbs,
  FileContentRenderer,
  FileExplorerPage,
  FilePathBreadcrumbs,
  FileSearch,
  FileThumbnail,
  FileTreeItem,
  VersionSelector,
  getFileCategory,
  getFileIcon,
  getLanguageFromExt,
} from './components';
export type { FileContentRendererProps } from './components';
