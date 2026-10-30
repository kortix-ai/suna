'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchProjectFileRaw } from '@kortix/sdk';
import { useProjectContext } from '../context';
import { toRepoRelative } from '../api/runtime-files';

export const binaryBlobKeys = {
  all: ['project-files', 'binary-blob'] as const,
  file: (projectId: string, ref: string, filePath: string) =>
    ['project-files', 'binary-blob', projectId, ref, filePath] as const,
};

/**
 * Load a project file as a Blob of its exact bytes, via React Query.
 *
 * This used to be a stub: `GET /projects/:id/files/content` carries `git show`
 * stdout as a UTF-8 string, so bytes that are not valid UTF-8 were already
 * lossy by the time they reached the client and every binary category — PDF,
 * image, docx, video, zip — was unpreviewable on the project files page (and
 * in a parked session, which reads the same git mirror). `GET /files/raw`
 * streams the real bytes now, so this fetches them.
 *
 * Returns both a blob URL (for <video>, <audio>, PdfRenderer) and the raw Blob
 * (for DocxRenderer, PptxRenderer). The Blob URL is derived per-mount and
 * revoked on unmount or when the underlying Blob changes; the raw Blob stays
 * in the React Query cache. A committed git ref is immutable, so there is no
 * turn-end invalidation here — nothing to keep fresh.
 */
export function useBinaryBlob(filePath: string | null): {
  blobUrl: string | null;
  blob: Blob | null;
  isLoading: boolean;
  error: string | null;
} {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';

  const query = useQuery<Blob>({
    queryKey: filePath ? binaryBlobKeys.file(projectId, ref, filePath) : [],
    queryFn: async ({ signal }) => {
      const blob = await fetchProjectFileRaw(projectId, toRepoRelative(filePath!), ref, signal ? { signal } : undefined);
      if (blob.size === 0) {
        throw new Error('File is empty (0 bytes).');
      }
      return blob;
    },
    enabled: !!projectId && !!ref && !!filePath,
    staleTime: 5 * 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error: Error) => {
      const msg = error.message.toLowerCase();
      if (msg.includes('404') || msg.includes('not found') || msg.includes('403')) return false;
      return failureCount < 3;
    },
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 5000),
  });

  const cachedBlob = query.data ?? null;

  // Blob URL — derived per-mount, revoked on unmount or when the Blob changes.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!cachedBlob) {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(cachedBlob);
    setBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [cachedBlob]);

  return useMemo(
    () => ({
      blobUrl,
      blob: cachedBlob,
      isLoading: query.isLoading,
      error: query.error?.message ?? null,
    }),
    [blobUrl, cachedBlob, query.isLoading, query.error?.message],
  );
}
