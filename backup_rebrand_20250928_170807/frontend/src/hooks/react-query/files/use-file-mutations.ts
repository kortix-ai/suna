import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/AuthProvider';
import { fileQueryKeys } from './use-file-queries';
import { FileCache } from '@/hooks/use-cached-file';
import { toast } from 'sonner';
// Import the normalizePath function from use-file-queries
function normalizePath(path: string): string {
  if (!path) return '/';
  
  // Remove any leading/trailing whitespace
  path = path.trim();
  
  // Ensure path starts with /
  if (!path.startsWith('/')) {
    path = '/' + path;
  }
  
  // Remove duplicate slashes and normalize
  path = path.replace(/\/+/g, '/');
  
  // Remove trailing slash unless it's the root
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  
  return path;
}

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

/**
 * Hook for uploading files
 */
export function useFileUpload() {
  const { session } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sandboxId,
      file,
      targetPath,
    }: {
      sandboxId: string;
      file: File;
      targetPath: string;
    }) => {
      if (!session?.access_token) {
        throw new Error('No access token available');
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('path', targetPath);

      const response = await fetch(`${API_URL}/sandboxes/${sandboxId}/files`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || 'Upload failed');
      }

      return await response.json();
    },
    onSuccess: (_, variables) => {
      // Invalidate directory listing for the target directory
      const directoryPath = variables.targetPath.substring(0, variables.targetPath.lastIndexOf('/'));
      queryClient.invalidateQueries({
        queryKey: fileQueryKeys.directory(variables.sandboxId, directoryPath),
      });

      // Also invalidate all file listings to be safe
      queryClient.invalidateQueries({
        queryKey: fileQueryKeys.directories(),
      });

      toast.success(`Uploaded: ${variables.file.name}`);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Upload failed: ${message}`);
    },
  });
}

/**
 * Hook for deleting files
 */
export function useFileDelete() {
  const { session } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sandboxId,
      filePath,
    }: {
      sandboxId: string;
      filePath: string;
    }) => {
      if (!session?.access_token) {
        throw new Error('No access token available');
      }

      const response = await fetch(
        `${API_URL}/sandboxes/${sandboxId}/files?path=${encodeURIComponent(filePath)}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || 'Delete failed');
      }

      return await response.json();
    },
    onSuccess: (_, variables) => {
      // Invalidate directory listing for the parent directory
      const directoryPath = variables.filePath.substring(0, variables.filePath.lastIndexOf('/'));
      queryClient.invalidateQueries({
        queryKey: fileQueryKeys.directory(variables.sandboxId, directoryPath),
      });

      // Invalidate all directory listings to be safe
      queryClient.invalidateQueries({
        queryKey: fileQueryKeys.directories(),
      });

      // Invalidate all file content queries for this specific file
      // This covers all content types (text, blob, json) for the deleted file
      queryClient.invalidateQueries({
        predicate: (query) => {
          const queryKey = query.queryKey;
          // Check if this is a file content query for our sandbox and file
          return (
            queryKey.length >= 4 &&
            queryKey[0] === 'files' &&
            queryKey[1] === 'content' &&
            queryKey[2] === variables.sandboxId &&
            queryKey[3] === variables.filePath
          );
        },
      });

      // Also remove the specific queries from cache completely
      ['text', 'blob', 'json'].forEach(contentType => {
        const queryKey = fileQueryKeys.content(variables.sandboxId, variables.filePath, contentType);
        queryClient.removeQueries({ queryKey });
      });

      // Clean up legacy FileCache entries for this file
      const normalizedPath = normalizePath(variables.filePath);
      const legacyCacheKeys = [
        `${variables.sandboxId}:${normalizedPath}:blob`,
        `${variables.sandboxId}:${normalizedPath}:text`,
        `${variables.sandboxId}:${normalizedPath}:json`,
        `${variables.sandboxId}:${normalizedPath}`,
        // Also try without leading slash for compatibility
        `${variables.sandboxId}:${normalizedPath.substring(1)}:blob`,
        `${variables.sandboxId}:${normalizedPath.substring(1)}:text`,
        `${variables.sandboxId}:${normalizedPath.substring(1)}:json`,
        `${variables.sandboxId}:${normalizedPath.substring(1)}`,
      ];

      legacyCacheKeys.forEach(key => {
        const cachedEntry = (FileCache as any).cache?.get(key);
        if (cachedEntry) {
          // If it's a blob URL, revoke it before deleting
          if (cachedEntry.type === 'url' && typeof cachedEntry.content === 'string' && cachedEntry.content.startsWith('blob:')) {
            URL.revokeObjectURL(cachedEntry.content);
          }
          FileCache.delete(key);
        }
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Delete failed: ${message}`);
    },
  });
}

/**
 * Hook for creating files
 */
export function useFileCreate() {
  const { session } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sandboxId,
      filePath,
      content,
    }: {
      sandboxId: string;
      filePath: string;
      content: string;
    }) => {
      if (!session?.access_token) {
        throw new Error('No access token available');
      }

      const response = await fetch(`${API_URL}/sandboxes/${sandboxId}/files`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: filePath,
          content,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || 'Create failed');
      }

      return await response.json();
    },
    onSuccess: (_, variables) => {
      // Invalidate directory listing for the parent directory
      const directoryPath = variables.filePath.substring(0, variables.filePath.lastIndexOf('/'));
      queryClient.invalidateQueries({
        queryKey: fileQueryKeys.directory(variables.sandboxId, directoryPath),
      });

      toast.success('File created successfully');
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Create failed: ${message}`);
    },
  });
} 