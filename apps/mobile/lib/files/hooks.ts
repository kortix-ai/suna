/**
 * Files & Sandbox API Hooks
 * React Query hooks with inline fetch calls
 */

import { useMutation, useQuery, useQueryClient, type UseMutationOptions, type UseQueryOptions } from '@tanstack/react-query';
import { API_URL, getAuthToken } from '@/api/config';
import type { SandboxFile, FileUploadResponse } from '@/api/types';

// API response types (what the backend actually returns)
interface ApiFileInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mod_time: string;
  permissions?: string;
}

interface ApiFilesResponse {
  files: ApiFileInfo[];
}

// Transform API response to SandboxFile
function transformApiFile(apiFile: ApiFileInfo): SandboxFile {
  return {
    name: apiFile.name,
    path: apiFile.path,
    type: apiFile.is_dir ? 'directory' : 'file',
    size: apiFile.size,
    modified: apiFile.mod_time,
  };
}

// ============================================================================
// API Types for Version History
// ============================================================================

export interface FileVersion {
  commit: string;
  author_name: string;
  author_email: string;
  date: string;
  message: string;
}

export interface FileHistoryResponse {
  path: string;
  versions: FileVersion[];
}

export interface CommitInfo {
  commit: string;
  message: string;
  date: string;
  author_name: string;
  author_email: string;
  files_in_commit: Array<{
    path: string;
    status: string;
    old_path?: string;
    revert_effect?: string;
  }>;
  revert_files: Array<{
    path: string;
    status: string;
    old_path?: string;
    revert_effect?: string;
  }>;
  path_affected_on_revert?: boolean;
}

// ============================================================================
// Query Keys
// ============================================================================

export const fileKeys = {
  all: ['files'] as const,
  sandboxFiles: (sandboxId: string, path: string) => [...fileKeys.all, 'sandbox', sandboxId, path] as const,
  sandboxFile: (sandboxId: string, path: string) => [...fileKeys.all, 'sandbox', sandboxId, 'file', path] as const,
  fileHistory: (sandboxId: string, path: string) => [...fileKeys.all, 'sandbox', sandboxId, 'history', path] as const,
  fileAtCommit: (sandboxId: string, path: string, commit: string) => [...fileKeys.all, 'sandbox', sandboxId, 'file', path, commit] as const,
  filesAtCommit: (sandboxId: string, path: string, commit: string) => [...fileKeys.all, 'sandbox', sandboxId, 'tree', path, commit] as const,
};

// ============================================================================
// Query Hooks
// ============================================================================

export function useSandboxFiles(
  sandboxId: string | undefined,
  path: string = '/workspace',
  options?: Omit<UseQueryOptions<SandboxFile[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: fileKeys.sandboxFiles(sandboxId || '', path),
    queryFn: async () => {
      const token = await getAuthToken();
      const res = await fetch(`${API_URL}/sandboxes/${sandboxId}/files?path=${encodeURIComponent(path)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to list files: ${res.status}`);
      const data: ApiFilesResponse = await res.json();
      // Transform API response to SandboxFile format
      return data.files.map(transformApiFile);
    },
    enabled: !!sandboxId,
    staleTime: 0,
    gcTime: 0, 
    ...options,
  });
}

export function useSandboxFileContent(
  sandboxId: string | undefined,
  filePath: string | undefined,
  options?: Omit<UseQueryOptions<string, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: fileKeys.sandboxFile(sandboxId || '', filePath || ''),
    queryFn: async () => {
      if (!filePath) throw new Error('File path required');

      const normalizedPath = filePath.startsWith('/workspace')
        ? filePath
        : `/workspace/${filePath.replace(/^\//, '')}`;

      const token = await getAuthToken();
      const res = await fetch(
        `${API_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(normalizedPath)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Failed to get file content: ${res.status}`);
      return res.text();
    },
    enabled: !!sandboxId && !!filePath,
    staleTime: 5 * 60 * 1000,
    ...options,
  });
}

export function useSandboxImageBlob(
  sandboxId: string | undefined,
  filePath: string | undefined,
  options?: Omit<UseQueryOptions<Blob, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: [...fileKeys.sandboxFile(sandboxId || '', filePath || ''), 'blob'],
    queryFn: async () => {
      if (!filePath) throw new Error('File path required');

      const normalizedPath = filePath.startsWith('/workspace')
        ? filePath
        : `/workspace/${filePath.replace(/^\//, '')}`;

      const token = await getAuthToken();
      const res = await fetch(
        `${API_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(normalizedPath)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Failed to load image: ${res.status}`);
      return res.blob();
    },
    enabled: !!sandboxId && !!filePath,
    staleTime: 10 * 60 * 1000,
    ...options,
  });
}

// ============================================================================
// Version History Hooks
// ============================================================================

/**
 * Hook to fetch file/workspace version history (git commits)
 */
export function useFileHistory(
  sandboxId: string | undefined,
  path: string = '/workspace',
  options?: Omit<UseQueryOptions<FileVersion[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: fileKeys.fileHistory(sandboxId || '', path),
    queryFn: async () => {
      if (!sandboxId) throw new Error('Sandbox ID required');

      const token = await getAuthToken();
      const res = await fetch(
        `${API_URL}/sandboxes/${sandboxId}/files/history?path=${encodeURIComponent(path)}&limit=100`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Failed to fetch file history: ${res.status}`);
      const data: FileHistoryResponse = await res.json();
      return data.versions || [];
    },
    enabled: !!sandboxId,
    staleTime: 30 * 1000, // 30 seconds
    ...options,
  });
}

/**
 * Hook to fetch file content at a specific commit
 */
export function useFileContentAtCommit(
  sandboxId: string | undefined,
  filePath: string | undefined,
  commit: string | undefined,
  options?: Omit<UseQueryOptions<Blob, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: fileKeys.fileAtCommit(sandboxId || '', filePath || '', commit || ''),
    queryFn: async () => {
      if (!sandboxId || !filePath || !commit) throw new Error('Missing required parameters');

      const normalizedPath = filePath.startsWith('/workspace')
        ? filePath
        : `/workspace/${filePath.replace(/^\//, '')}`;

      const token = await getAuthToken();
      const res = await fetch(
        `${API_URL}/sandboxes/${sandboxId}/files/content-by-hash?path=${encodeURIComponent(normalizedPath)}&commit=${encodeURIComponent(commit)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Failed to fetch file at commit: ${res.status}`);
      return res.blob();
    },
    enabled: !!sandboxId && !!filePath && !!commit,
    staleTime: Infinity, // Historical content doesn't change
    ...options,
  });
}

/**
 * Hook to fetch directory tree at a specific commit
 */
export function useFilesAtCommit(
  sandboxId: string | undefined,
  path: string = '/workspace',
  commit: string | undefined,
  options?: Omit<UseQueryOptions<SandboxFile[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: fileKeys.filesAtCommit(sandboxId || '', path, commit || ''),
    queryFn: async () => {
      if (!sandboxId || !commit) throw new Error('Missing required parameters');

      const token = await getAuthToken();
      const res = await fetch(
        `${API_URL}/sandboxes/${sandboxId}/files/tree?path=${encodeURIComponent(path)}&commit=${encodeURIComponent(commit)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Failed to fetch files at commit: ${res.status}`);
      const data = await res.json();
      return (data.files || []).map(transformApiFile);
    },
    enabled: !!sandboxId && !!commit,
    staleTime: Infinity, // Historical content doesn't change
    ...options,
  });
}

/**
 * Mutation hook to revert files to a specific commit
 */
export function useRevertToCommit(
  options?: UseMutationOptions<
    { success: boolean; message: string },
    Error,
    { sandboxId: string; commit: string; paths?: string[] }
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sandboxId, commit, paths }) => {
      const token = await getAuthToken();
      const body: { commit: string; paths?: string[] } = { commit };
      if (paths && paths.length > 0) {
        body.paths = paths;
      }

      const res = await fetch(`${API_URL}/sandboxes/${sandboxId}/files/revert`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Revert failed');
      }
      return res.json();
    },
    onSuccess: (_, variables) => {
      // Invalidate file queries after revert
      queryClient.invalidateQueries({
        queryKey: ['files', 'sandbox', variables.sandboxId],
        exact: false,
        refetchType: 'all',
      });
    },
    ...options,
  });
}

/**
 * Fetch commit info (files changed in commit)
 */
export async function fetchCommitInfo(
  sandboxId: string,
  commit: string,
  filePath?: string
): Promise<CommitInfo> {
  const token = await getAuthToken();
  let url = `${API_URL}/sandboxes/${sandboxId}/files/commit-info?commit=${encodeURIComponent(commit)}`;
  if (filePath) {
    url += `&path=${encodeURIComponent(filePath)}`;
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Failed to fetch commit info');
  }
  return res.json();
}

// ============================================================================
// Mutation Hooks
// ============================================================================

export function useUploadFileToSandbox(
  options?: UseMutationOptions<
    FileUploadResponse,
    Error,
    { sandboxId: string; file: { uri: string; name: string; type: string }; destinationPath?: string }
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sandboxId, file, destinationPath }) => {
      const token = await getAuthToken();
      if (!token) throw new Error('Authentication required');

      const normalizedName = file.name.normalize('NFC');
      const uploadPath = destinationPath || `/workspace/uploads/${normalizedName}`;

      const formData = new FormData();
      formData.append('file', {
        uri: file.uri,
        name: normalizedName,
        type: file.type || 'application/octet-stream',
      } as any);
      formData.append('path', uploadPath);

      const res = await fetch(`${API_URL}/sandboxes/${sandboxId}/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      return res.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ 
        queryKey: ['files', 'sandbox', variables.sandboxId],
        exact: false,           
        refetchType: 'all',
      });
    },
    ...options,
  });
}

export function useUploadMultipleFiles(
  options?: UseMutationOptions<
    FileUploadResponse[],
    Error,
    {
      sandboxId: string;
      files: Array<{ uri: string; name: string; type: string }>;
      onProgress?: (file: string, progress: number) => void;
    }
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sandboxId, files, onProgress }) => {
      const token = await getAuthToken();
      if (!token) throw new Error('Authentication required');

      const results: FileUploadResponse[] = [];

      for (const file of files) {
        const normalizedName = file.name.normalize('NFC');
        const formData = new FormData();
        formData.append('file', {
          uri: file.uri,
          name: normalizedName,
          type: file.type || 'application/octet-stream',
        } as any);
        formData.append('path', `/workspace/uploads/${normalizedName}`);

        const res = await fetch(`${API_URL}/sandboxes/${sandboxId}/files`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });

        if (!res.ok) throw new Error(`Upload failed for ${file.name}: ${res.status}`);
        
        const result = await res.json();
        results.push(result);
        onProgress?.(file.name, 100);
      }

      return results;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ 
        queryKey: ['files', 'sandbox', variables.sandboxId],
        exact: false,
        refetchType: 'all',
      });
    },
    ...options,
  });
}

export function useDeleteSandboxFile(
  options?: UseMutationOptions<void, Error, { sandboxId: string; filePath: string }>
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sandboxId, filePath }) => {
      const token = await getAuthToken();
      const res = await fetch(
        `${API_URL}/sandboxes/${sandboxId}/files?path=${encodeURIComponent(filePath)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!res.ok) throw new Error(`Failed to delete file: ${res.status}`);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ 
        queryKey: ['files', 'sandbox', variables.sandboxId],
        exact: false,
        refetchType: 'all',
      });
    },
    ...options,
  });
}

export function useCreateSandboxDirectory(
  options?: UseMutationOptions<void, Error, { sandboxId: string; dirPath: string }>
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sandboxId, dirPath }) => {
      const token = await getAuthToken();
      const res = await fetch(`${API_URL}/sandboxes/${sandboxId}/directories`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: dirPath }),
      });
      if (!res.ok) throw new Error(`Failed to create directory: ${res.status}`);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ 
        queryKey: ['files', 'sandbox', variables.sandboxId],
        exact: false,
        refetchType: 'all',
      });
    },
    ...options,
  });
}

export function useDownloadSandboxFile() {
  return useMutation({
    mutationFn: async ({ sandboxId, filePath }: { sandboxId: string; filePath: string }) => {
      const token = await getAuthToken();
      const res = await fetch(
        `${API_URL}/sandboxes/${sandboxId}/files/download?path=${encodeURIComponent(filePath)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
      return res.blob();
    },
  });
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Get proper mime type from file extension
 */
function getMimeTypeFromExtension(extension: string): string | null {
  const mimeTypes: Record<string, string> = {
    // Images
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'bmp': 'image/bmp',
    'ico': 'image/x-icon',
    'heic': 'image/heic',
    'heif': 'image/heif',
    // Videos
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
  };
  return mimeTypes[extension.toLowerCase()] || null;
}

/**
 * Convert blob to data URL, optionally fixing the mime type based on file extension
 */
export async function blobToDataURL(blob: Blob, filePath?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      let dataUrl = reader.result as string;
      
      // If the blob has application/octet-stream mime type and we have a file path,
      // try to fix the mime type based on the file extension
      if (blob.type === 'application/octet-stream' && filePath) {
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        const correctMimeType = getMimeTypeFromExtension(ext);
        if (correctMimeType) {
          // Replace the incorrect mime type in the data URL
          dataUrl = dataUrl.replace(
            'data:application/octet-stream',
            `data:${correctMimeType}`
          );
        }
      }
      
      resolve(dataUrl);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
