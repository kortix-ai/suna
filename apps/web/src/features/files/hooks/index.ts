/**
 * Files feature hooks — all backed by the OpenCode server API.
 */

// Directory listing
export {
  useFileList,
  useInvalidateFileList,
  fileListKeys,
} from './use-file-list';

// File content reading
export {
  useFileContent,
  useInvalidateFileContent,
  fileContentKeys,
} from './use-file-content';

// File/text search
export {
  useFileSearch,
  useTextSearch,
  fileSearchKeys,
} from './use-file-search';

// Standalone workspace search (CMD+K, @-mentions, etc.)
export {
  useWorkspaceSearch,
  searchWorkspaceFiles,
  rankFileResult,
  parseFileResults,
  type FileSearchResult,
  type WorkspaceSearchState,
  type UseWorkspaceSearchOptions,
} from './use-workspace-search';

// Semantic search (LSS)
export { useLssSearch, lssSearchKeys } from './use-lss-search';

// Server health & project info
export { useServerHealth, useCurrentProject } from './use-server-health';

// File mutations (write operations)
export {
  useFileUpload,
  useFileDelete,
  useFileMkdir,
  useFileRename,
  useFileCreate,
  useFileCopy,
} from './use-file-mutations';

// Git status
export {
  useGitStatus,
  buildGitStatusMap,
  gitStatusKeys,
} from './use-git-status';

// Binary blob loading (shared between file-content-renderer & show-content-renderer)
export { useBinaryBlob, binaryBlobKeys } from './use-binary-blob';

// SSE-based real-time invalidation
export { useFileEventInvalidation } from './use-file-events';

// Git history
export {
  useFileHistory,
  useFileCommitDiff,
  useFileAtCommit,
  fileHistoryKeys,
} from './use-file-history';
