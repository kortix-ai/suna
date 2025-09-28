// Core React Query file hooks
export {
  useFileContentQuery,
  useDirectoryQuery,
  useFilePreloader,
  useCachedFile,
  fileQueryKeys,
  FileCache,
} from './use-file-queries';

// Specialized content hooks
export { useFileContent } from './use-file-content';
export { useImageContent } from './use-image-content';

// File mutation hooks
export {
  useFileUpload,
  useFileDelete,
  useFileCreate,
} from './use-file-mutations';

// Utility functions for compatibility
export {
  getCachedFile,
  fetchFileContent,
} from './use-file-queries'; 