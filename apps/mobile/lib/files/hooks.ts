/**
 * Sandbox file hooks. Reads and the rename/delete verbs go through the
 * `@kortix/sdk` file client, each call naming its sandbox with `baseUrl`. Two
 * paths stay native because React Native cannot do them through `fetch` + Blob:
 * the download to disk (bytes never enter the JS heap) and the `{ uri }`
 * multipart upload.
 */

import { useMutation, useQuery, useQueryClient, type UseMutationOptions, type UseQueryOptions } from '@tanstack/react-query';
import * as FileSystem from 'expo-file-system/legacy';
import { deleteFile, listFiles, readBlob, readFile, renameFile } from '@kortix/sdk';
import { getAuthToken } from '@/api/config';
import type { SandboxFile } from '@/api/types';
import { normalizeFilenameToNFC } from './utils';

// ============================================================================
// Query Keys
// ============================================================================

export const fileKeys = {
  all: ['files'] as const,
  sandbox: (sandboxUrl: string) => [...fileKeys.all, 'sandbox', sandboxUrl] as const,
  list: (sandboxUrl: string, path: string) => [...fileKeys.sandbox(sandboxUrl), path] as const,
  file: (sandboxUrl: string, path: string) => [...fileKeys.sandbox(sandboxUrl), 'file', path] as const,
  blob: (sandboxUrl: string, path: string) => [...fileKeys.sandbox(sandboxUrl), 'blob', path] as const,
};

// ============================================================================
// Reads
// ============================================================================

/** List a sandbox directory. */
export function useSandboxFiles(
  sandboxUrl: string | undefined,
  path: string = '/workspace',
  options?: Omit<UseQueryOptions<SandboxFile[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: fileKeys.list(sandboxUrl || '', path),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      const nodes = await listFiles(path, sandboxUrl);
      return nodes.map((node): SandboxFile => ({ name: node.name, path: node.path, type: node.type }));
    },
    enabled: !!sandboxUrl,
    staleTime: 5_000,
    gcTime: 2 * 60_000,
    retry: (count, error) => {
      const status = (error as { status?: number } | null)?.status;
      if (status === 404 || status === 403) return false;
      return count < 2;
    },
    ...options,
  });
}

/** Read a file's text. A binary file comes back as its base64 string. */
export function useSandboxFileContent(
  sandboxUrl: string | undefined,
  filePath: string | undefined,
  options?: Omit<UseQueryOptions<string, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: fileKeys.file(sandboxUrl || '', filePath || ''),
    queryFn: async () => {
      if (!sandboxUrl || !filePath) throw new Error('Missing params');
      return (await readFile(filePath, sandboxUrl)).content ?? '';
    },
    enabled: !!sandboxUrl && !!filePath,
    staleTime: 5 * 60_000,
    ...options,
  });
}

/** Read a file as a Blob: raw bytes first, the base64 content read as the fallback. */
export function useSandboxFileBlob(
  sandboxUrl: string | undefined,
  filePath: string | undefined,
  options?: Omit<UseQueryOptions<Blob, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: fileKeys.blob(sandboxUrl || '', filePath || ''),
    queryFn: async () => {
      if (!sandboxUrl || !filePath) throw new Error('Missing params');
      return readBlob(filePath, sandboxUrl);
    },
    enabled: !!sandboxUrl && !!filePath,
    staleTime: 10 * 60_000,
    // A blob can hold a whole preview-sized file; release it soon after the viewer closes.
    gcTime: 60_000,
    ...options,
  });
}

/**
 * Download a file straight to the cache directory with GET {sandboxUrl}/file/raw.
 * The bytes stream to disk natively and never enter the JS heap, so this works
 * for files too large to preview. Returns the local file:// URI.
 */
export async function downloadSandboxFileToCache(
  sandboxUrl: string,
  filePath: string,
  fileName: string,
): Promise<string> {
  const token = await getAuthToken();
  const target = `${FileSystem.cacheDirectory}${fileName}`;
  const result = await FileSystem.downloadAsync(
    `${sandboxUrl}/file/raw?path=${encodeURIComponent(filePath)}`,
    target,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  const contentType = Object.entries(result.headers).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1];
  // A text/html body for a non-HTML file is the SPA shell of a stale proxy, not the file.
  const isSpaShell = (contentType ?? '').includes('text/html') && !/\.html?$/i.test(filePath);
  if (result.status !== 200 || isSpaShell) {
    FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
    throw new Error(`Failed to download file: ${result.status}`);
  }
  return result.uri;
}

/**
 * Upload a file from the device: POST {sandboxUrl}/file/upload with a `{ uri }` part.
 */
export function useUploadSandboxFile(
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
        queryKey: fileKeys.sandbox(variables.sandboxUrl),
        refetchType: 'all',
      });
    },
    ...options,
  });
}

/**
 * Write (create or OVERWRITE) a text file.
 *
 * /file/upload never overwrites: it suffixes on collision. So the new content
 * goes up under a unique temp name in the same directory and is then renamed
 * onto the target. The rename overwrites atomically, so the file is never
 * missing; when the rename fails the temp upload is removed.
 */
export function useWriteSandboxFile(
  options?: UseMutationOptions<
    { path: string },
    Error,
    { sandboxUrl: string; path: string; content: string }
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sandboxUrl, path: fullPath, content }) => {
      const token = await getAuthToken();
      const slash = fullPath.lastIndexOf('/');
      const dir = slash >= 0 ? fullPath.slice(0, slash) : '';
      const name = slash >= 0 ? fullPath.slice(slash + 1) : fullPath;
      const tempName = `${name}.ktx-save-${Date.now()}`;
      const remoteTemp = dir ? `${dir}/${tempName}` : tempName;

      // 1. Stage the new content as a local temp file (decoupled from the
      //    multipart filename, which is what the server uses for the dest path).
      const localUri = `${FileSystem.cacheDirectory}ktx-edit-${Date.now()}.tmp`;
      await FileSystem.writeAsStringAsync(localUri, content);

      try {
        // 2. Upload to the unique temp name → lands exactly at {dir}/{tempName}.
        const formData = new FormData();
        formData.append('path', dir);
        formData.append('file', { uri: localUri, name: tempName, type: 'text/plain' } as any);
        const up = await fetch(`${sandboxUrl}/file/upload`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        });
        if (!up.ok) {
          throw new Error(`Upload failed: ${up.status} ${await up.text().catch(() => '')}`);
        }

        // 3. Rename temp → target (atomic overwrite).
        try {
          await renameFile(remoteTemp, fullPath, sandboxUrl);
        } catch (error) {
          // Best-effort: drop the orphaned temp so it doesn't litter the tree.
          deleteFile(remoteTemp, sandboxUrl).catch(() => {});
          throw error;
        }
        return { path: fullPath };
      } finally {
        FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
      }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: fileKeys.sandbox(variables.sandboxUrl),
        refetchType: 'all',
      });
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

