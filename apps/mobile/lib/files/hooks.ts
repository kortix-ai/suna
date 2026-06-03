/**
 * Files & Sandbox API Hooks
 * React Query hooks with inline fetch calls
 */

import { useMutation, useQuery, useQueryClient, type UseMutationOptions, type UseQueryOptions } from '@tanstack/react-query';
import { API_URL, getAuthToken } from '@/api/config';
import type { SandboxFile } from '@/api/types';
import { normalizeFilenameToNFC } from './utils';

// ============================================================================
// Query Keys
// ============================================================================

export const fileKeys = {
  all: ['files'] as const,
  opencode: (sandboxUrl: string, path: string) => [...fileKeys.all, 'opencode', sandboxUrl, path] as const,
  opencodeFile: (sandboxUrl: string, path: string) => [...fileKeys.all, 'opencode', sandboxUrl, 'file', path] as const,
  opencodeBlob: (sandboxUrl: string, path: string) => [...fileKeys.all, 'opencode', sandboxUrl, 'blob', path] as const,
};

// ============================================================================
// OpenCode File API Types (GET /file?path=... response)
// ============================================================================

/** Response item from the OpenCode /file endpoint */
interface OpenCodeFileNode {
  name: string;
  path: string;       // relative to project root
  absolute: string;   // absolute filesystem path
  type: 'file' | 'directory';
  ignored: boolean;
}

/** Transform OpenCode FileNode to SandboxFile for UI compatibility */
function transformOpenCodeFile(node: OpenCodeFileNode): SandboxFile {
  return {
    name: node.name,
    path: node.absolute || node.path,
    type: node.type,
  };
}

// ============================================================================
// OpenCode File API Hooks (via sandboxUrl — same as frontend)
// ============================================================================

/**
 * List files using the OpenCode API: GET {sandboxUrl}/file?path=...
 * This is the same endpoint the frontend uses.
 */
export function useOpenCodeFiles(
  sandboxUrl: string | undefined,
  path: string = '/workspace',
  options?: Omit<UseQueryOptions<SandboxFile[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: fileKeys.opencode(sandboxUrl || '', path),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      const token = await getAuthToken();
      const res = await fetch(
        `${sandboxUrl}/file?path=${encodeURIComponent(path)}`,
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      if (!res.ok) throw new Error(`Failed to list files: ${res.status}`);
      const data: OpenCodeFileNode[] = await res.json();
      return data.map(transformOpenCodeFile);
    },
    enabled: !!sandboxUrl,
    staleTime: 5_000,
    gcTime: 2 * 60_000,
    retry: (count, error) => {
      // Don't retry 404/403
      if (error?.message?.includes('404') || error?.message?.includes('403')) return false;
      return count < 2;
    },
    ...options,
  });
}

/**
 * Read file content using OpenCode API: GET {sandboxUrl}/file/read?path=...
 */
export function useOpenCodeFileContent(
  sandboxUrl: string | undefined,
  filePath: string | undefined,
  options?: Omit<UseQueryOptions<string, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: fileKeys.opencodeFile(sandboxUrl || '', filePath || ''),
    queryFn: async () => {
      if (!sandboxUrl || !filePath) throw new Error('Missing params');
      const token = await getAuthToken();

      // GET /file/content?path=... returns JSON { content, encoding?, mimeType? }
      const res = await fetch(
        `${sandboxUrl}/file/content?path=${encodeURIComponent(filePath)}`,
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      if (!res.ok) throw new Error(`Failed to read file: ${res.status}`);
      const data = await res.json();
      // For base64-encoded binary files, decode
      if (data.encoding === 'base64' && data.content) {
        return data.content as string; // Return base64 as-is, preview renderer handles it
      }
      return (data.content ?? '') as string;
    },
    enabled: !!sandboxUrl && !!filePath,
    staleTime: 5 * 60_000,
    ...options,
  });
}

/**
 * Read file as blob using OpenCode API.
 * Tries GET /file/raw first, falls back to /file/content (base64 decode).
 */
export function useOpenCodeFileBlob(
  sandboxUrl: string | undefined,
  filePath: string | undefined,
  options?: Omit<UseQueryOptions<Blob, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: fileKeys.opencodeBlob(sandboxUrl || '', filePath || ''),
    queryFn: async () => {
      if (!sandboxUrl || !filePath) throw new Error('Missing params');
      const token = await getAuthToken();
      const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };

      // Try /file/raw first (binary stream)
      try {
        const rawRes = await fetch(
          `${sandboxUrl}/file/raw?path=${encodeURIComponent(filePath)}`,
          { headers },
        );
        if (rawRes.ok) {
          const contentType = rawRes.headers.get('content-type') || '';
          // Make sure we didn't get an HTML page back
          if (!contentType.includes('text/html')) {
            return rawRes.blob();
          }
        }
      } catch {
        // /file/raw not available, fall through
      }

      // Fallback: /file/content returns JSON with base64 content
      const res = await fetch(
        `${sandboxUrl}/file/content?path=${encodeURIComponent(filePath)}`,
        { headers },
      );
      if (!res.ok) throw new Error(`Failed to load file: ${res.status}`);
      const data = await res.json();
      if (data.encoding === 'base64' && data.content) {
        const binary = atob(data.content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: data.mimeType || 'application/octet-stream' });
      }
      // Text content
      return new Blob([data.content || ''], { type: data.mimeType || 'text/plain' });
    },
    enabled: !!sandboxUrl && !!filePath,
    staleTime: 10 * 60_000,
    ...options,
  });
}

/**
 * Upload file using OpenCode API: POST {sandboxUrl}/file/upload
 */
export function useOpenCodeUploadFile(
  options?: UseMutationOptions<
    any,
    Error,
    { sandboxUrl: string; file: { uri: string; name: string; type: string }; targetPath: string }
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sandboxUrl, file, targetPath }) => {
      const token = await getAuthToken();
      const normalizedName = normalizeFilenameToNFC(file.name);
      const formData = new FormData();
      formData.append('path', targetPath);
      formData.append('file', {
        uri: file.uri,
        name: normalizedName,
        type: file.type || 'application/octet-stream',
      } as any);

      const res = await fetch(`${sandboxUrl}/file/upload`, {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: formData,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Upload failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['files', 'opencode', variables.sandboxUrl],
        exact: false,
        refetchType: 'all',
      });
    },
    ...options,
  });
}

/**
 * Delete file using OpenCode API: DELETE {sandboxUrl}/file
 */
export function useOpenCodeDeleteFile(
  options?: UseMutationOptions<any, Error, { sandboxUrl: string; filePath: string }>
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sandboxUrl, filePath }) => {
      const token = await getAuthToken();
      const res = await fetch(`${sandboxUrl}/file`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ path: filePath }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Delete failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['files', 'opencode', variables.sandboxUrl],
        exact: false,
        refetchType: 'all',
      });
    },
    ...options,
  });
}

/**
 * Create directory using OpenCode API: POST {sandboxUrl}/file/mkdir
 */
export function useOpenCodeMkdir(
  options?: UseMutationOptions<any, Error, { sandboxUrl: string; dirPath: string }>
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sandboxUrl, dirPath }) => {
      const token = await getAuthToken();
      const res = await fetch(`${sandboxUrl}/file/mkdir`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ path: dirPath }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Mkdir failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['files', 'opencode', variables.sandboxUrl],
        exact: false,
        refetchType: 'all',
      });
    },
    ...options,
  });
}

/**
 * Rename/move a file using OpenCode API: POST {sandboxUrl}/file/rename
 */
export function useOpenCodeRenameFile(
  options?: UseMutationOptions<any, Error, { sandboxUrl: string; from: string; to: string }>
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sandboxUrl, from, to }) => {
      const token = await getAuthToken();
      const res = await fetch(`${sandboxUrl}/file/rename`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ from, to }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Rename failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['files', 'opencode', variables.sandboxUrl],
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
