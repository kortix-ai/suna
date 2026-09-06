/**
 * Files feature hooks — all backed by the OpenCode server API.
 */

// Directory listing
export { fileListKeys, useFileList, useInvalidateFileList } from './use-file-list';

// File content reading
export { fileContentKeys, useFileContent, useInvalidateFileContent } from './use-file-content';

// File search
export { fileSearchKeys, useFileSearch } from './use-file-search';

// Server health & project info
export { useCurrentProject, useServerHealth } from './use-server-health';

// File mutations (write operations)
export {
  useFileCopy,
  useFileCreate,
  useFileDelete,
  useFileMkdir,
  useFileRename,
  useFileUpload,
} from './use-file-mutations';

// Git status
export { buildGitStatusMap, gitStatusKeys, useGitStatus } from './use-git-status';

// Binary blob loading (shared between file-content-renderer & show-content-renderer)
export { binaryBlobKeys, useBinaryBlob } from './use-binary-blob';

// SSE-based real-time invalidation
export { useFileEventInvalidation } from '@/features/file-browser/hooks/use-file-events';

// Git history
export {
  fileHistoryKeys,
  useFileAtCommit,
  useFileCommitDiff,
  useFileHistory,
} from './use-file-history';
