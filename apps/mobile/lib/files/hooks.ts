/**
 * Files & Sandbox API Hooks
 * React Query hooks with inline fetch calls
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseMutationOptions, type UseQueryOptions } from '@tanstack/react-query';
import { API_URL, getAuthToken } from '@/api/config';
import type { SandboxFile, FileUploadResponse } from '@/api/types';
import type { SandboxState, SandboxStatus } from '@agentpress/shared/types/sandbox';
import { normalizeFilenameToNFC } from './utils';

// Re-export sandbox types for convenience
export type { SandboxState, SandboxStatus } from '@agentpress/shared/types/sandbox';
export {
  deriveSandboxStatus,
  isSandboxUsable,
  isSandboxTransitioning,
  isSandboxOffline,
  isSandboxFailed,
  getSandboxStatusLabel,
} from '@agentpress/shared/types/sandbox';

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

export const sandboxKeys = {
  all: ['sandbox'] as const,
  status: (projectId: string) => [...sandboxKeys.all, 'status', projectId] as const,
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

      // Normalize filename for Unix compatibility (removes colons, special chars, etc.)
      const normalizedName = normalizeFilenameToNFC(file.name);
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


export function useStageFiles(
  options?: UseMutationOptions<
    Array<{ file_id: string; filename: string; storage_path: string; mime_type: string; file_size: number; status: string }>,
    Error,
    {
      files: Array<{ uri: string; name: string; type: string; fileId: string }>;
      onProgress?: (fileId: string, progress: number) => void;
    }
  >
) {
  return useMutation({
    mutationFn: async ({ files, onProgress }) => {
      const token = await getAuthToken();
      if (!token) throw new Error('Authentication required');

      const results: Array<{ file_id: string; filename: string; storage_path: string; mime_type: string; file_size: number; status: string }> = [];

      for (const file of files) {
        // Normalize filename for Unix compatibility (removes colons, special chars, etc.)
        const normalizedName = normalizeFilenameToNFC(file.name);
        const formData = new FormData();
        formData.append('file', {
          uri: file.uri,
          name: normalizedName,
          type: file.type || 'application/octet-stream',
        } as any);
        formData.append('file_id', file.fileId);

        const res = await fetch(`${API_URL}/files/stage`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });

        if (!res.ok) throw new Error(`Staging failed for ${file.name}: ${res.status}`);
        
        const result = await res.json();
        results.push(result);
        onProgress?.(file.fileId, 100);
      }

      return results;
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
        // Normalize filename for Unix compatibility (removes colons, special chars, etc.)
        const normalizedName = normalizeFilenameToNFC(file.name);
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

/**
 * Hook to upload files to a project (creates sandbox on-demand if needed)
 * This is the preferred method for file uploads as it doesn't require sandbox_id upfront
 */
export function useUploadFilesToProject(
  options?: UseMutationOptions<
    FileUploadResponse[],
    Error,
    {
      projectId: string;
      files: Array<{ uri: string; name: string; type: string }>;
      onProgress?: (file: string, progress: number) => void;
    }
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ projectId, files, onProgress }) => {
      const token = await getAuthToken();
      if (!token) throw new Error('Authentication required');

      // Signal upload start
      try {
        await fetch(`${API_URL}/project/${projectId}/files/upload-started`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ file_count: files.length }),
        });
      } catch (e) {
        console.warn('Failed to signal upload start:', e);
      }

      const results: FileUploadResponse[] = [];

      try {
        for (const file of files) {
          // Normalize filename for Unix compatibility
          const normalizedName = normalizeFilenameToNFC(file.name);
          const uploadPath = `/workspace/uploads/${normalizedName}`;

          const formData = new FormData();
          formData.append('file', {
            uri: file.uri,
            name: normalizedName,
            type: file.type || 'application/octet-stream',
          } as any);
          formData.append('path', uploadPath);

          const res = await fetch(`${API_URL}/project/${projectId}/files`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
          });

          if (!res.ok) {
            if (res.status === 431) {
              throw new Error('Request is too large');
            }
            throw new Error(`Upload failed: ${res.statusText}`);
          }

          const result = await res.json();
          results.push(result);
          onProgress?.(file.name, 100);
        }
      } finally {
        // Signal upload complete
        try {
          await fetch(`${API_URL}/project/${projectId}/files/upload-completed`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch (e) {
          console.warn('Failed to signal upload complete:', e);
        }
      }

      return results;
    },
    onSuccess: (_, variables) => {
      // Invalidate sandbox status to reflect new files
      queryClient.invalidateQueries({ 
        queryKey: sandboxKeys.status(variables.projectId),
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
    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
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

// ============================================================================
// Sandbox Status Hooks
// ============================================================================

/**
 * Hook to fetch unified sandbox status by PROJECT ID
 */
export function useSandboxStatus(
  projectId: string | undefined,
  options?: Omit<UseQueryOptions<SandboxState, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: sandboxKeys.status(projectId || ''),
    queryFn: async () => {
      if (!projectId) throw new Error('Project ID required');

      const token = await getAuthToken();
      const res = await fetch(
        `${API_URL}/project/${projectId}/sandbox/status`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!res.ok) throw new Error(`Failed to fetch sandbox status: ${res.status}`);
      return res.json() as Promise<SandboxState>;
    },
    enabled: !!projectId,
    staleTime: 5 * 1000,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Fast polling for transitional states, slower for stable states
      if (status === 'STARTING' || status === 'UNKNOWN') {
        return 3000; // 3s for transitional states
      }
      if (status === 'OFFLINE') {
        return 5000; // 5s for offline (waiting for auto-start to take effect)
      }
      return 30000; // 30s for LIVE/FAILED (stable states)
    },
    ...options,
  });
}

/**
 * Hook to fetch unified sandbox status by SANDBOX ID directly
 * Use this when you have a sandboxId but no projectId
 */
export function useSandboxStatusById(
  sandboxId: string | undefined,
  options?: Omit<UseQueryOptions<SandboxState, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: ['sandbox', 'status-by-id', sandboxId || ''],
    queryFn: async () => {
      if (!sandboxId) throw new Error('Sandbox ID required');

      const token = await getAuthToken();
      const url = `${API_URL}/sandboxes/${sandboxId}/status`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const errorText = await res.text();
        if (res.status === 404) {
          throw new Error(`Endpoint not found - make sure backend is updated and restarted`);
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Authentication failed: ${res.status}`);
        }
        throw new Error(`Failed to fetch sandbox status: ${res.status} - ${errorText}`);
      }

      const data = await res.json();

      // Validate that we got a proper status
      if (!data || !data.status) {
        throw new Error('Invalid sandbox status response: missing status field');
      }

      return data as SandboxState;
    },
    enabled: !!sandboxId,
    staleTime: 5 * 1000,
    retry: 1,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Fast polling for transitional states, slower for stable states
      if (status === 'STARTING' || status === 'UNKNOWN') {
        return 3000; // 3s for transitional states
      }
      if (status === 'OFFLINE') {
        return 5000; // 5s for offline (waiting for auto-start to take effect)
      }
      return 30000; // 30s for LIVE/FAILED (stable states)
    },
    ...options,
  });
}

/**
 * Mutation hook to start a sandbox
 */
export function useStartSandbox(
  options?: UseMutationOptions<
    { status: string; sandbox_id: string; message: string },
    Error,
    string
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (projectId: string) => {
      const token = await getAuthToken();
      const res = await fetch(`${API_URL}/project/${projectId}/sandbox/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        throw new Error(`Failed to start sandbox: ${res.status}`);
      }

      return res.json();
    },
    onSuccess: (_, projectId) => {
      // Invalidate status query to trigger refetch
      queryClient.invalidateQueries({ queryKey: sandboxKeys.status(projectId) });
    },
    ...options,
  });
}

/**
 * Mutation hook to stop a sandbox (by project ID)
 */
export function useStopSandbox(
  options?: UseMutationOptions<
    { status: string; sandbox_id: string; message: string },
    Error,
    string
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (projectId: string) => {
      const token = await getAuthToken();
      const res = await fetch(`${API_URL}/project/${projectId}/sandbox/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) throw new Error(`Failed to stop sandbox: ${res.status}`);
      return res.json();
    },
    onSuccess: (_, projectId) => {
      // Invalidate status query to trigger refetch
      queryClient.invalidateQueries({ queryKey: sandboxKeys.status(projectId) });
    },
    ...options,
  });
}

/**
 * Mutation hook to start a sandbox by SANDBOX ID directly
 * Use this when you have a sandboxId but no projectId
 */
export function useStartSandboxById(
  options?: UseMutationOptions<
    { status: string; sandbox_id: string; message: string },
    Error,
    string
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sandboxId: string) => {
      const token = await getAuthToken();
      const res = await fetch(`${API_URL}/sandboxes/${sandboxId}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        throw new Error(`Failed to start sandbox: ${res.status}`);
      }

      return res.json();
    },
    onSuccess: (_, sandboxId) => {
      // Invalidate status-by-id query to trigger refetch
      queryClient.invalidateQueries({ queryKey: ['sandbox', 'status-by-id', sandboxId] });
    },
    ...options,
  });
}

// ============================================================================
// Auto-Start Hook - Combines status checking with automatic restart
// ============================================================================

// Global map to track auto-start attempts per project
// This prevents multiple hook instances from triggering simultaneous starts
const globalAutoStartAttempted = new Map<string, boolean>();
const globalAutoStartInProgress = new Map<string, boolean>();

/**
 * Hook that monitors sandbox status and auto-starts if OFFLINE.
 *
 * Features:
 * - Auto-starts sandbox when OFFLINE is detected (with sandbox_id present)
 * - Doesn't auto-start for UNKNOWN (no sandbox exists yet - need to create via agent)
 * - Tracks "isAutoStarting" state for UI feedback
 * - Prevents multiple auto-start attempts (globally across all hook instances)
 * - Returns effective status (STARTING during auto-start attempt)
 *
 * @param projectId - Project ID to monitor
 * @param options.enabled - Whether to enable the hook (default: true)
 * @param options.autoStart - Whether to auto-start OFFLINE sandboxes (default: true)
 */
export function useSandboxStatusWithAutoStart(
  projectId: string | undefined,
  options?: {
    enabled?: boolean;
    autoStart?: boolean;
  }
) {
  const autoStartEnabled = options?.autoStart !== false;
  const [isAutoStarting, setIsAutoStarting] = useState(false);
  const lastProjectIdRef = useRef<string | undefined>(undefined);

  // Reset auto-start state when project changes
  useEffect(() => {
    if (lastProjectIdRef.current !== projectId && projectId) {
      // Clear global state for the new project
      globalAutoStartAttempted.delete(projectId);
      globalAutoStartInProgress.delete(projectId);
      setIsAutoStarting(false);
      lastProjectIdRef.current = projectId;
    }
  }, [projectId]);

  // Sync local state with global state
  useEffect(() => {
    if (projectId) {
      const inProgress = globalAutoStartInProgress.get(projectId) || false;
      setIsAutoStarting(inProgress);
    }
  }, [projectId]);

  // Get sandbox status
  const statusQuery = useSandboxStatus(projectId, { enabled: options?.enabled });
  const sandboxState = statusQuery.data;

  // Start sandbox mutation
  const startSandbox = useStartSandbox();

  // Use ref to avoid stale closures with mutation
  const startSandboxRef = useRef(startSandbox);
  startSandboxRef.current = startSandbox;

  // Auto-start logic
  const attemptAutoStart = useCallback(async () => {
    if (!projectId) return;

    const alreadyAttempted = globalAutoStartAttempted.get(projectId);
    const alreadyInProgress = globalAutoStartInProgress.get(projectId);

    if (!autoStartEnabled) return;
    if (alreadyAttempted || alreadyInProgress) return;
    if (!sandboxState) return;

    // Only auto-start if:
    // 1. Status is OFFLINE (sandbox exists but stopped)
    // 2. We have a sandbox_id (confirms sandbox exists)
    // 3. Not already starting
    const shouldAutoStart =
      sandboxState.status === 'OFFLINE' &&
      sandboxState.sandbox_id &&
      sandboxState.sandbox_id.length > 0 &&
      !startSandboxRef.current.isPending;

    if (shouldAutoStart) {
      // CRITICAL: Set global flags SYNCHRONOUSLY before any async work
      // This prevents multiple hook instances from triggering simultaneous starts
      globalAutoStartAttempted.set(projectId, true);
      globalAutoStartInProgress.set(projectId, true);
      setIsAutoStarting(true);

      try {
        await startSandboxRef.current.mutateAsync(projectId);
      } catch (error) {
        console.error('[useSandboxStatusWithAutoStart] Auto-start failed:', error);
        // Reset so user can try again
        globalAutoStartAttempted.set(projectId, false);
        globalAutoStartInProgress.set(projectId, false);
        setIsAutoStarting(false);
      }
    }
  }, [projectId, autoStartEnabled, sandboxState]);

  // Trigger auto-start when status becomes OFFLINE
  useEffect(() => {
    if (sandboxState?.status === 'OFFLINE') {
      attemptAutoStart();
    }
    // Clear isAutoStarting when status changes away from OFFLINE (sandbox is now running)
    if (projectId && sandboxState?.status && sandboxState.status !== 'OFFLINE') {
      globalAutoStartInProgress.set(projectId, false);
      setIsAutoStarting(false);
    }
  }, [sandboxState?.status, attemptAutoStart, projectId]);

  // Compute effective status - show STARTING if we're auto-starting
  const effectiveStatus: SandboxStatus | undefined =
    isAutoStarting && sandboxState?.status === 'OFFLINE'
      ? 'STARTING'
      : sandboxState?.status;

  return {
    ...statusQuery,
    // Override data to include effective status
    data: sandboxState ? {
      ...sandboxState,
      status: effectiveStatus || sandboxState.status,
    } : null,
    // Expose original status for debugging
    originalStatus: sandboxState?.status,
    // Whether we're in the process of auto-starting
    isAutoStarting,
    // Whether auto-start is enabled
    autoStartEnabled,
    // Reset auto-start attempt (e.g., for manual retry)
    resetAutoStart: useCallback(() => {
      if (projectId) {
        globalAutoStartAttempted.set(projectId, false);
        globalAutoStartInProgress.set(projectId, false);
      }
      setIsAutoStarting(false);
    }, [projectId]),
  };
}

// Global map to track auto-start attempts per sandbox (by ID)
// This prevents multiple hook instances from triggering simultaneous starts
const globalAutoStartAttemptedById = new Map<string, boolean>();
const globalAutoStartInProgressById = new Map<string, boolean>();

/**
 * Hook that monitors sandbox status by SANDBOX ID and auto-starts if OFFLINE.
 * Use this when you have a sandboxId but no projectId.
 *
 * @param sandboxId - Sandbox ID to monitor
 * @param options.enabled - Whether to enable the hook (default: true)
 * @param options.autoStart - Whether to auto-start OFFLINE sandboxes (default: true)
 */
export function useSandboxStatusByIdWithAutoStart(
  sandboxId: string | undefined,
  options?: {
    enabled?: boolean;
    autoStart?: boolean;
  }
) {
  const autoStartEnabled = options?.autoStart !== false;
  const [isAutoStarting, setIsAutoStarting] = useState(false);
  const lastSandboxIdRef = useRef<string | undefined>(undefined);

  // Reset auto-start state when sandbox changes
  useEffect(() => {
    if (lastSandboxIdRef.current !== sandboxId && sandboxId) {
      // Clear global state for the new sandbox
      globalAutoStartAttemptedById.delete(sandboxId);
      globalAutoStartInProgressById.delete(sandboxId);
      setIsAutoStarting(false);
      lastSandboxIdRef.current = sandboxId;
    }
  }, [sandboxId]);

  // Sync local state with global state
  useEffect(() => {
    if (sandboxId) {
      const inProgress = globalAutoStartInProgressById.get(sandboxId) || false;
      setIsAutoStarting(inProgress);
    }
  }, [sandboxId]);

  // Get sandbox status by ID
  const queryEnabled = options?.enabled !== false && !!sandboxId;
  const statusQuery = useSandboxStatusById(sandboxId, { enabled: queryEnabled });
  const sandboxState = statusQuery.data;

  // Start sandbox mutation (by sandbox ID)
  const startSandbox = useStartSandboxById();

  // Use ref to avoid stale closures with mutation
  const startSandboxRef = useRef(startSandbox);
  startSandboxRef.current = startSandbox;

  // Auto-start logic
  const attemptAutoStart = useCallback(async () => {
    if (!sandboxId) return;

    const alreadyAttempted = globalAutoStartAttemptedById.get(sandboxId);
    const alreadyInProgress = globalAutoStartInProgressById.get(sandboxId);

    if (!autoStartEnabled) return;
    if (alreadyAttempted || alreadyInProgress) return;
    if (!sandboxState) return;

    // Only auto-start if status is OFFLINE
    const shouldAutoStart = sandboxState.status === 'OFFLINE' && !startSandboxRef.current.isPending;

    if (shouldAutoStart) {
      // CRITICAL: Set global flags SYNCHRONOUSLY before any async work
      globalAutoStartAttemptedById.set(sandboxId, true);
      globalAutoStartInProgressById.set(sandboxId, true);
      setIsAutoStarting(true);

      try {
        await startSandboxRef.current.mutateAsync(sandboxId);
      } catch (error) {
        console.error('[useSandboxStatusByIdWithAutoStart] Auto-start failed:', error);
        globalAutoStartAttemptedById.set(sandboxId, false);
        globalAutoStartInProgressById.set(sandboxId, false);
        setIsAutoStarting(false);
      }
    }
  }, [sandboxId, autoStartEnabled, sandboxState]);

  // Trigger auto-start when status becomes OFFLINE
  useEffect(() => {
    if (sandboxState?.status === 'OFFLINE') {
      attemptAutoStart();
    }
    // Clear isAutoStarting when status changes away from OFFLINE
    if (sandboxId && sandboxState?.status && sandboxState.status !== 'OFFLINE') {
      globalAutoStartInProgressById.set(sandboxId, false);
      setIsAutoStarting(false);
    }
  }, [sandboxState?.status, attemptAutoStart, sandboxId]);

  // Compute effective status - show STARTING if we're auto-starting
  const effectiveStatus: SandboxStatus | undefined =
    isAutoStarting && sandboxState?.status === 'OFFLINE'
      ? 'STARTING'
      : sandboxState?.status;

  return {
    ...statusQuery,
    data: sandboxState ? {
      ...sandboxState,
      status: effectiveStatus || sandboxState.status,
    } : null,
    originalStatus: sandboxState?.status,
    isAutoStarting,
    autoStartEnabled,
    resetAutoStart: useCallback(() => {
      if (sandboxId) {
        globalAutoStartAttemptedById.set(sandboxId, false);
        globalAutoStartInProgressById.set(sandboxId, false);
      }
      setIsAutoStarting(false);
    }, [sandboxId]),
  };
}
