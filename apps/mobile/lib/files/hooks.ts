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
// Query Keys
// ============================================================================

export const fileKeys = {
  all: ['files'] as const,
  sandboxFiles: (sandboxId: string, path: string) => [...fileKeys.all, 'sandbox', sandboxId, path] as const,
  sandboxFile: (sandboxId: string, path: string) => [...fileKeys.all, 'sandbox', sandboxId, 'file', path] as const,
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

export async function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
