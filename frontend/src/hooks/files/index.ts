/**
 * File Hooks
 */
export { useCachedFile, FileCache, getCachedFile, fetchFileContent } from './use-cached-file';
export { useVncPreloader, type VncStatus } from './useVncPreloader';

// Export file query hooks and utilities
export {
  useFileContentQuery,
  useDirectoryQuery,
  useFilePreloader,
  fileQueryKeys,
  fetchFileContent as fetchFileContentFromQuery,
  getCachedFile as getCachedFileFromQuery,
} from './use-file-queries';

// Alias for backward compatibility
export { useFileContentQuery as useFileContent } from './use-file-queries';

// Export file mutations
export {
  useFileUpload,
  useFileDelete,
  useFileCreate,
} from './use-file-mutations';

// Export image content hook
export { useImageContent } from './use-image-content';


