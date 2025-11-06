import { useFileContentQuery } from './use-file-queries';

/**
 * Hook for fetching file content with React Query
 * Replaces the existing useFileContent hook
 * Now auto-detects content type for proper caching consistency
 */
export function useFileContent(
  sandboxId?: string,
  filePath?: string,
  options: {
    enabled?: boolean;
    staleTime?: number;
  } = {}
) {
  return useFileContentQuery(sandboxId, filePath, {
    // Auto-detect content type for consistency across all hooks
    enabled: options.enabled,
    staleTime: options.staleTime,
  });
} 