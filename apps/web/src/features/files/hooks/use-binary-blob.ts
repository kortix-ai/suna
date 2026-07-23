'use client';

import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { readFileAsBlob } from '../api/runtime-files';
import { fileReadRetryDelayMs, shouldRetryFileRead } from './file-read-retry';

// ── Query keys ─────────────────────────────────────────────────────────────

export const binaryBlobKeys = {
  all: ['runtime-files', 'binary-blob'] as const,
  file: (serverUrl: string, filePath: string) =>
    ['runtime-files', 'binary-blob', serverUrl, filePath] as const,
};

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * Load a file from the sandbox as a binary Blob via React Query.
 *
 * Returns both a blob URL (for <video>, <audio>, PdfRenderer, etc.)
 * and the raw Blob (for DocxRenderer, PptxRenderer).
 *
 * Pass `null` for filePath to disable loading.
 *
 * IMPORTANT — Blob URL lifecycle:
 *   React Query caches only the raw Blob (stable, never revoked).
 *   The blob URL is derived per-mount via URL.createObjectURL and
 *   revoked on unmount or when the underlying Blob changes.
 *   This prevents the stale-blob-URL bug where navigating away and
 *   back would serve a revoked URL from the query cache.
 */
export function useBinaryBlob(filePath: string | null): {
  blobUrl: string | null;
  blob: Blob | null;
  isLoading: boolean;
  error: string | null;
} {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  // ── Fetch the raw Blob — this is what React Query caches ────────────
  const query = useQuery<Blob>({
    queryKey: filePath
      ? binaryBlobKeys.file(serverUrl, filePath)
      : ['runtime-files', 'binary-blob', '__disabled__'],
    queryFn: async () => {
      const blob = await readFileAsBlob(filePath!);
      if (blob.size === 0) {
        throw new Error('File is empty (0 bytes). It may still be generating — try again in a moment.');
      }
      return blob;
    },
    enabled: !!filePath,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => shouldRetryFileRead(filePath, failureCount, error),
    retryDelay: (attempt) => fileReadRetryDelayMs(attempt, filePath),
  });

  const cachedBlob = query.data ?? null;

  // ── Blob URL — derived per-mount, revoked on unmount/change ─────────
  // Each component mount creates its own blob URL from the cached Blob.
  // When the component unmounts the URL is revoked, but the raw Blob
  // stays safe in React Query's cache for the next mount.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!cachedBlob) {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(cachedBlob);
    setBlobUrl(url);

    // Revoke when the Blob changes or on unmount
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [cachedBlob]);

  // ── Stable return value ──────────────────────────────────────────────
  return useMemo(() => ({
    blobUrl,
    blob: cachedBlob,
    isLoading: query.isLoading,
    error: query.error?.message ?? null,
  }), [blobUrl, cachedBlob, query.isLoading, query.error?.message]);
}
